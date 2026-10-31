import { analyzeAudioBuffer } from '../src/audio/analysis-client.ts';

const status = document.querySelector('#status')!, results = document.querySelector('#results')!;
const button = document.querySelector<HTMLButtonElement>('#run')!;
const lines: string[] = [];
function pass(name: string, valid: boolean, detail: string) {
  if (!valid) throw new Error(`${name}: ${detail}`);
  lines.push(`PASS ${name}: ${detail}`); results.textContent = lines.join('\n');
}
const rate = 48000;
function tone(frequency: number, duration = 2, gain = 0.2, stereo = false) {
  const buffer = new AudioBuffer({ sampleRate: rate, length: rate * duration, numberOfChannels: stereo ? 2 : 1 });
  for (let i = 0; i < buffer.length; i++) {
    const value = gain * Math.sin(2 * Math.PI * frequency * i / rate);
    buffer.getChannelData(0)[i] = value;
    if (stereo) buffer.getChannelData(1)[i] = -value;
  }
  return buffer;
}
const run = (buffer: AudioBuffer, onProgress = (_value: number) => {}) => analyzeAudioBuffer(buffer, onProgress, new AbortController().signal);

button.onclick = async () => {
  button.disabled = true; lines.length = 0; results.textContent = ''; status.textContent = 'Running…';
  try {
    const source = tone(100), original = source.getChannelData(0)[37], progress: number[] = [];
    const bass = await run(source, value => progress.push(value));
    pass('native worker analyzes bass', bass.bands[1].energyPercent > 98, `${bass.bands[1].energyPercent.toFixed(4)}% in 60-150 Hz`);
    pass('source PCM remains intact', source.getChannelData(0).byteLength === rate * 2 * 4 && source.getChannelData(0)[37] === original, `${source.length} playback samples retained`);
    pass('worker progress reaches completion', progress.at(-1) === 1 && progress.some(value => value > 0 && value < 1) && progress.every((v, i) => !i || v >= progress[i - 1]), `${progress.length} monotonic updates`);
    const quiet = await run(tone(100, 2, 0.002));
    const difference = Math.max(...bass.bands.map((band, i) => Math.abs(band.energyPercent - quiet.bands[i].energyPercent)));
    pass('worker features are gain invariant', difference < 0.001, `maximum band difference ${difference.toFixed(8)} percentage points`);
    const stereo = await run(tone(100, 2, 0.2, true));
    pass('opposite-phase stereo is retained', Math.abs(stereo.bands[1].energyPercent - bass.bands[1].energyPercent) < 0.001, `${stereo.bands[1].energyPercent.toFixed(4)}% bass`);
    const silence = new AudioBuffer({ sampleRate: rate, length: rate, numberOfChannels: 2 });
    const empty = await run(silence);
    pass('silence is handled cleanly', !empty.hasContent && empty.rmsDbfs === null && empty.bands.every(b => b.energyPercent === 0), 'empty spectrum and null RMS');
    const late = new AudioBuffer({ sampleRate: rate, length: rate * 6, numberOfChannels: 1 });
    late.copyToChannel(tone(7000, 2).getChannelData(0), 0, rate * 4);
    const ending = await run(late);
    pass('analysis covers the end of the recording', ending.bands[6].energyPercent > 98 && ending.sections[0].activeFraction === 0 && ending.sections.at(-1)!.energyPercent[6] > 98, `${ending.sections.length} sections, late treble measured`);
    const controller = new AbortController();
    const pending = analyzeAudioBuffer(tone(100, 60, 0.2, true), () => {}, controller.signal);
    controller.abort(); let cancelled = false;
    try { await pending; } catch (error) { cancelled = error instanceof DOMException && error.name === 'AbortError'; }
    pass('cancellation terminates a real worker', cancelled, 'AbortError returned without waiting for extraction');
    status.textContent = `All ${lines.length} native worker checks passed`;
  } catch (error) { status.textContent = 'Worker verification failed'; results.textContent += `\nFAIL ${error instanceof Error ? error.message : String(error)}`; }
  finally { button.disabled = false; }
};
