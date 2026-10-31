import { createAdaptivePlan } from '../src/audio/adaptive.ts';
import { analyzeSamples } from '../src/audio/track-analysis.ts';
import { HEADPHONE_PROFILES, EqualizerChain, createFilters, measureResponse, combinedResponse, responseGrid, responsePreamp, checkTrackPeaks, samplePeak, gainToDb } from '../src/audio/equalizer.ts';
import type { HeadphoneProfile, PlaybackMode } from '../src/audio/equalizer.ts';
import { analysisFixture } from './adaptive-fixture.ts';
import { songFixture } from './song-fixtures.ts';

const status = document.querySelector('#status')!, results = document.querySelector('#results')!;
const button = document.querySelector<HTMLButtonElement>('#run')!, lines: string[] = [];
const profile = HEADPHONE_PROFILES[0];
function pass(name: string, valid: boolean, detail: string) {
  if (!valid) throw new Error(`${name}: ${detail}`);
  lines.push(`PASS ${name}: ${detail}`); results.textContent = lines.join('\n');
}
function tone(frequency: number, sampleRate = 48000, duration = 4) {
  const buffer = new AudioBuffer({ sampleRate, length: sampleRate * duration, numberOfChannels: 1 });
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = 0.2 * Math.sin(2 * Math.PI * frequency * i / sampleRate);
  return buffer;
}
async function render(buffer: AudioBuffer, adaptive: HeadphoneProfile | null, mode: PlaybackMode, trim: number, switching = false) {
  const context = new OfflineAudioContext(buffer.numberOfChannels, buffer.length + Math.ceil(buffer.sampleRate * 0.5), buffer.sampleRate);
  const input = context.createGain(), output = context.createGain();
  const chain = new EqualizerChain(context as unknown as AudioContext, input, output);
  chain.install(profile); if (adaptive) chain.installAdaptive(adaptive);
  chain.apply(mode, trim, false); output.connect(context.destination);
  const source = context.createBufferSource(); source.buffer = buffer; source.connect(input); source.start();
  if (switching) {
    // Suspend at exact sample boundaries to exercise actual scheduled crossfades.
    const suspensions = [0.5, 1, 1.5].map((time, i) => context.suspend(time).then(async () => {
      chain.apply((['adaptive', 'bypass', 'corrected'] as const)[i], trim, true); await context.resume();
    }));
    const rendered = await context.startRendering(); await Promise.all(suspensions); chain.dispose(); return rendered;
  }
  const rendered = await context.startRendering(); chain.dispose(); return rendered;
}
function rms(data: Float32Array, start: number, end: number) {
  let total = 0; for (let i = start; i < end; i++) total += data[i] ** 2;
  return Math.sqrt(total / (end - start));
}
button.onclick = async () => {
  button.disabled = true; lines.length = 0; results.textContent = ''; status.textContent = 'Running…';
  try {
    for (const rate of [44100, 48000]) {
      const context = new OfflineAudioContext(1, 128, rate);
      const base = measureResponse(createFilters(context, profile), rate);
      const summaries = (['bass-heavy', 'bright'] as const).map(kind => analyzeSamples({ sampleRate: rate, channels: [songFixture(kind, rate, 4)] }));
      const plans = summaries.map(summary => createAdaptivePlan(context, profile, base, summary, 1));
      pass(`${rate} Hz real analysis changes the adaptive setting`, plans.every(p => p.status === 'ready') && plans[0].profile.id !== plans[1].profile.id, `bass vs treble delta ${plans.map(p => p.maxDeltaDb.toFixed(4)).join(' / ')} dB`);
      for (const [index, plan] of plans.entries()) {
        const grid = responseGrid(rate);
        const original = combinedResponse(createFilters(context, profile), grid), adapted = combinedResponse(createFilters(context, plan.profile), grid);
        const delta = Math.max(...adapted.map((value, i) => Math.abs(value - original[i])));
        pass(`${rate} Hz ${index ? 'bright' : 'bass'} full combined curve bound`, delta <= 5 && Math.abs(delta - plan.maxDeltaDb) < 1e-6, `${delta.toFixed(6)} dB at 4098 checked frequencies`);
      }
      pass(`${rate} Hz headphone calibration stays intact`, plans.every(p => JSON.stringify(p.profile.filters.slice(0, profile.filters.length)) === JSON.stringify(profile.filters) && p.profile.filters.slice(profile.filters.length).length <= 8 && p.profile.filters.slice(profile.filters.length).every(f => Math.abs(f.gain) <= 5 && f.q <= 1.35)), 'full imported preset plus fitted broad song filters');
      pass(`${rate} Hz robust spectral detail reaches the EQ`, summaries.every(s => s.spectral?.bands.length === 30) && plans.every(p => p.diagnostics!.fitErrorDb < 0.7), `fit errors ${plans.map(p => p.diagnostics!.fitErrorDb.toFixed(3)).join(' / ')} dB`);
      const plan = plans[0];
      const frequency = 821, source = tone(frequency, rate, 2), trim = Math.min(responsePreamp(profile, base), responsePreamp(plan.profile, plan.response));
      const actual = await render(source, plan.profile, 'adaptive', trim);
      const observed = gainToDb(rms(actual.getChannelData(0), rate / 2, rate * 2) / rms(source.getChannelData(0), rate / 2, rate * 2));
      const expected = trim + combinedResponse(createFilters(context, plan.profile), new Float32Array([frequency]))[0];
      pass(`${rate} Hz adaptive graph matches actual output`, Math.abs(observed - expected) < 0.03, `error ${Math.abs(observed - expected).toFixed(6)} dB`);
      const zero = createAdaptivePlan(context, profile, base, summaries[0], 0);
      const measured = await render(source, null, 'corrected', trim), restored = await render(source, zero.profile, 'adaptive', trim);
      let difference = 0; measured.getChannelData(0).forEach((value, i) => { difference = Math.max(difference, Math.abs(value - restored.getChannelData(0)[i])); });
      pass(`${rate} Hz zero restores measured output exactly`, zero.profile === profile && difference === 0, `maximum sample difference ${difference}`);
    }
    const context = new OfflineAudioContext(1, 128, 48000);
    const base = measureResponse(createFilters(context, profile), 48000);
    const broad = analysisFixture(), energies = [42, 42, 2, 2, 2, 2, 4, 4];
    broad.bands.forEach((band, i) => { band.energyPercent = energies[i]; band.activityPercent = 100; });
    const limited = createAdaptivePlan(context, profile, base, broad, 1);
    pass('overlapping song filters obey the combined bound', limited.maxDeltaDb > 0 && limited.maxDeltaDb <= 5, `combined delta ${limited.maxDeltaDb.toFixed(6)} dB, individual filter caps 5 dB`);
    broad.bands.forEach(band => { band.energyPercent = 12.5; });
    const warm = createAdaptivePlan(context, profile, base, broad, 1, 'warm'), clear = createAdaptivePlan(context, profile, base, broad, 1, 'clear');
    pass('tonal targets change the song layer direction', warm.changes[0].adaptiveGainDb > clear.changes[0].adaptiveGainDb && warm.changes.at(-1)!.adaptiveGainDb < clear.changes.at(-1)!.adaptiveGainDb, `bass warm ${warm.changes[0].adaptiveGainDb.toFixed(3)} vs clear ${clear.changes[0].adaptiveGainDb.toFixed(3)} dB`);
    const plan = createAdaptivePlan(context, profile, base, analysisFixture(), 1);
    const hot = new AudioBuffer({ numberOfChannels: 2, length: 96000, sampleRate: 48000 });
    for (let c = 0; c < 2; c++) { const data = hot.getChannelData(c); for (let i = 0; i < data.length; i++) data[i] = 1.2 * Math.sin(2 * Math.PI * (c ? 6000 : 30) * i / 48000); data[100] = c ? -3.5 : 3.5; }
    const candidate = Math.min(responsePreamp(profile, base), responsePreamp(plan.profile, plan.response));
    const baselineCheck = await checkTrackPeaks(hot, profile, candidate), adaptiveCheck = await checkTrackPeaks(hot, plan.profile, candidate);
    const trim = Math.min(baselineCheck.preampDb, adaptiveCheck.preampDb);
    for (const mode of ['bypass', 'corrected', 'adaptive'] as const) {
      const output = await render(hot, plan.profile, mode, trim), actual = gainToDb(samplePeak(output));
      const checked = mode === 'adaptive' ? adaptiveCheck : baselineCheck;
      const predicted = (mode === 'bypass' ? checked.originalPeakDb : checked.correctedPeakDb) + trim - checked.preampDb;
      pass(`${mode} shares verified sample-peak headroom`, actual <= -1 + 0.0001 && Math.abs(actual - predicted) < 0.001, `actual ${actual.toFixed(6)} dBFS, predicted ${predicted.toFixed(6)} dBFS`);
    }
    const switched = await render(hot, plan.profile, 'corrected', trim, true);
    pass('live three-mode crossfades remain bounded', gainToDb(samplePeak(switched)) <= -1 + 0.0001, `rendered sample peak ${gainToDb(samplePeak(switched)).toFixed(6)} dBFS`);
    status.textContent = `${lines.length} adaptive checks passed`;
  } catch (error) { status.textContent = 'FAILED'; results.textContent += `\nFAIL ${error instanceof Error ? error.message : error}`; }
  finally { button.disabled = false; }
};
