import { HEADPHONE_PROFILES, EqualizerChain, createFilters, measureResponse, responsePreamp, checkTrackPeaks, samplePeak, gainToDb, dbToGain } from '../src/audio/equalizer.ts';

const profile = HEADPHONE_PROFILES[0];
const status = document.querySelector('#status')!;
const results = document.querySelector('#results')!;
const button = document.querySelector<HTMLButtonElement>('#run')!;
const lines: string[] = [];
function pass(name: string, valid: boolean, detail: string) {
  if (!valid) throw new Error(`${name}: ${detail}`);
  lines.push(`PASS ${name}: ${detail}`);
  results.textContent = lines.join('\n');
}
async function render(buffer: AudioBuffer, preampDb: number, corrected: boolean) {
  const offline = new OfflineAudioContext(buffer.numberOfChannels, buffer.length + Math.ceil(buffer.sampleRate * 0.5), buffer.sampleRate);
  const input = offline.createGain(), output = offline.createGain();
  const chain = new EqualizerChain(offline as unknown as AudioContext, input, output);
  chain.install(profile); chain.apply(corrected, preampDb, false);
  output.connect(offline.destination);
  const source = offline.createBufferSource(); source.buffer = buffer; source.connect(input); source.start();
  const rendered = await offline.startRendering();
  chain.dispose(); input.disconnect(); output.disconnect(); source.disconnect();
  return rendered;
}
function rms(data: Float32Array, start: number, end: number) {
  let power = 0;
  for (let i = start; i < end; i++) power += data[i] ** 2;
  return Math.sqrt(power / (end - start));
}

button.onclick = async () => {
  button.disabled = true; status.textContent = 'Running…'; lines.length = 0; results.textContent = '';
  try {
    for (const sampleRate of [44100, 48000]) {
      const responseContext = new OfflineAudioContext(1, 128, sampleRate);
      const filters = createFilters(responseContext, profile);
      const response = measureResponse(filters, sampleRate);
      const trim = responsePreamp(profile, response);
      for (const frequency of [30, 100, 500, 1000, 3000, 6000, 12000]) {
        const input = new AudioBuffer({ numberOfChannels: 1, length: Math.round(sampleRate * 1.2), sampleRate });
        const samples = input.getChannelData(0);
        for (let i = 0; i < samples.length; i++) samples[i] = 0.15 * Math.sin(2 * Math.PI * frequency * i / sampleRate);
        const output = await render(input, trim, true);
        const start = Math.round(sampleRate * 0.2), end = Math.round(sampleRate * 1.2);
        const measured = gainToDb(rms(output.getChannelData(0), start, end) / rms(samples, start, end));
        const magnitudes = new Float32Array(1), phases = new Float32Array(1);
        let expected = trim;
        for (const filter of filters) { filter.getFrequencyResponse(new Float32Array([frequency]), magnitudes, phases); expected += gainToDb(magnitudes[0]); }
        const error = Math.abs(expected - measured);
        pass(`${sampleRate} Hz / ${frequency} Hz graph vs playback`, error < 0.03, `error ${error.toFixed(6)} dB`);
      }
      filters.forEach(node => node.disconnect());
    }

    const sampleRate = 48000;
    const hot = new AudioBuffer({ numberOfChannels: 2, length: sampleRate * 2, sampleRate });
    for (let channel = 0; channel < 2; channel++) {
      const samples = hot.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) samples[i] = 1.2 * Math.sin(2 * Math.PI * (channel ? 6000 : 30) * i / sampleRate);
      samples[100] = channel ? -3.5 : 3.5;
    }
    const raw = await render(hot, 0, false);
    pass('offline float output retains overshoots', samplePeak(raw) > 3.49, `peak ${samplePeak(raw).toFixed(4)}`);
    const responseContext = new OfflineAudioContext(1, 128, sampleRate);
    const response = measureResponse(createFilters(responseContext, profile), sampleRate);
    const candidate = responsePreamp(profile, response);
    const checked = await checkTrackPeaks(hot, profile, candidate);
    pass('rendered peak verification adds required trim', checked.preampDb < candidate, `candidate ${candidate.toFixed(4)} dB, checked ${checked.preampDb.toFixed(4)} dB`);
    for (const corrected of [false, true]) {
      const rendered = await render(hot, checked.preampDb, corrected);
      const actual = gainToDb(samplePeak(rendered));
      const reported = corrected ? checked.correctedPeakDb : checked.originalPeakDb;
      pass(`${corrected ? 'corrected' : 'bypass'} actual sample-peak ceiling`, actual <= -1 + 0.0001 && Math.abs(actual - reported) < 0.001, `actual ${actual.toFixed(6)} dBFS, reported ${reported.toFixed(6)} dBFS`);
    }
    const dry = await render(hot, checked.preampDb, false);
    let difference = 0;
    for (let channel = 0; channel < 2; channel++) {
      const input = hot.getChannelData(channel), output = dry.getChannelData(channel);
      for (let i = 0; i < input.length; i++) difference = Math.max(difference, Math.abs(output[i] - input[i] * dbToGain(checked.preampDb)));
    }
    pass('bypass is dry audio with only the shared trim', difference < 0.000001, `maximum sample difference ${difference.toExponential(3)}`);
    const silence = new AudioBuffer({ numberOfChannels: 2, length: sampleRate, sampleRate });
    const silentResult = await checkTrackPeaks(silence, profile, candidate);
    pass('silent track stays silent', silentResult.originalPeakDb === -Infinity && silentResult.correctedPeakDb === -Infinity && Number.isFinite(silentResult.preampDb), `trim ${silentResult.preampDb.toFixed(4)} dB`);
    status.textContent = `All ${lines.length} native DSP checks passed`;
  } catch (error) {
    status.textContent = 'DSP verification failed';
    results.textContent += `\nFAIL ${error instanceof Error ? error.message : String(error)}`;
  } finally { button.disabled = false; }
};
