import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSamples } from '../src/audio/track-analysis.ts';
import { FFT_SIZE, HOP_SIZE } from '../src/audio/analysis-model.ts';
import { AudioEngine } from '../src/audio/AudioEngine.ts';
import { FakeContext } from './fake-audio.mjs';

const sr = 48000;
function tone(frequency, seconds = 1, amplitude = 0.2, sampleRate = sr) {
  return Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate));
}
const analyze = (...channels) => analyzeSamples({ sampleRate: sr, channels });
const total = values => values.reduce((sum, value) => sum + value, 0);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const file = name => ({ name, size: 44, arrayBuffer: async () => new ArrayBuffer(44) });

test('bass and treble fixtures concentrate power in the expected broad bands', () => {
  const frequencies = [40, 100, 250, 700, 1700, 3500, 7000, 14000];
  for (let i = 0; i < frequencies.length; i++) {
    const result = analyze(tone(frequencies[i]));
    assert.ok(result.hasContent);
    assert.ok(result.bands[i].energyPercent > 97, `${frequencies[i]} Hz: ${result.bands[i].energyPercent}`);
    assert.ok(Math.abs(total(result.bands.map(b => b.energyPercent)) - 100) < 1e-8);
  }
});

test('a sine has the expected source RMS and waveform crest factor', () => {
  const result = analyze(tone(1000));
  assert.ok(Math.abs(result.rmsDbfs - 20 * Math.log10(0.2 / Math.sqrt(2))) < 0.001);
  assert.ok(Math.abs(result.crestDb - 20 * Math.log10(Math.sqrt(2))) < 0.001);
  assert.equal(result.fftSize, FFT_SIZE);
  assert.equal(result.hopSize, HOP_SIZE);
});

test('uniform source gain changes levels but preserves spectral and activity features', () => {
  const input = Float32Array.from(tone(100, 2), (value, i) => value + 0.1 * Math.sin(2 * Math.PI * 3500 * i / sr));
  const original = analyze(input), quieter = analyze(Float32Array.from(input, v => v * 0.01));
  original.bands.forEach((band, i) => {
    assert.ok(Math.abs(band.energyPercent - quieter.bands[i].energyPercent) < 0.001);
    assert.ok(Math.abs(band.activityPercent - quieter.bands[i].activityPercent) < 0.001);
    assert.ok(Math.abs(band.medianSharePercent - quieter.bands[i].medianSharePercent) < 0.001);
  });
  assert.equal(original.analyzedFrames, quieter.analyzedFrames);
  assert.ok(Math.abs(original.rmsDbfs - quieter.rmsDbfs - 40) < 0.001);
  assert.ok(Math.abs(original.crestDb - quieter.crestDb) < 0.001);
});

test('opposite-phase stereo retains the same spectrum as the mono signal', () => {
  const input = tone(250);
  const mono = analyze(input), stereo = analyze(input, Float32Array.from(input, value => -value));
  mono.bands.forEach((band, i) => assert.ok(Math.abs(band.energyPercent - stereo.bands[i].energyPercent) < 0.00001));
  assert.ok(stereo.bands[2].energyPercent > 98);
  assert.ok(Math.abs(mono.rmsDbfs - stereo.rmsDbfs) < 0.00001);
});

test('separate stereo content combines channel powers rather than their waveforms', () => {
  const result = analyze(tone(100, 2), tone(7000, 2));
  assert.ok(result.bands[1].energyPercent > 45 && result.bands[1].energyPercent < 55);
  assert.ok(result.bands[6].energyPercent > 45 && result.bands[6].energyPercent < 55);
});

test('silence and DC-only recordings produce finite, empty spectral summaries', () => {
  for (const samples of [new Float32Array(sr), new Float32Array(sr).fill(0.25)]) {
    const result = analyze(samples);
    assert.equal(result.hasContent, false);
    assert.equal(result.analyzedFrames, 0);
    assert.ok(result.bands.every(band => band.energyPercent === 0 && band.activityPercent === 0));
    assert.ok(result.sections.every(section => total(section.energyPercent) === 0));
    assert.doesNotThrow(() => JSON.stringify(result));
  }
  assert.equal(analyze(new Float32Array(sr)).rmsDbfs, null);
});

test('late audio is analyzed and silent sections remain empty', () => {
  const samples = new Float32Array(sr * 6);
  samples.set(tone(7000, 2), sr * 4);
  const result = analyze(samples);
  assert.ok(result.bands[6].energyPercent > 98);
  assert.equal(total(result.sections[0].energyPercent), 0);
  assert.equal(result.sections[0].activeFraction, 0);
  assert.ok(result.sections.at(-1).energyPercent[6] > 98);
  assert.ok(result.analyzedFrames < result.totalFrames / 2);
});

test('the timeline captures a change in content between track sections', () => {
  const samples = new Float32Array(sr * 4);
  samples.set(tone(100, 2)); samples.set(tone(7000, 2), sr * 2);
  const result = analyze(samples);
  assert.ok(result.sections[0].energyPercent[1] > 98);
  assert.ok(result.sections.at(-1).energyPercent[6] > 98);
  assert.ok(result.bands[1].variationPercentPoints > 30);
  assert.equal(result.sections.at(-1).endSeconds, 4);
});

test('short clips, fractional boundary bins, and reduced sample rates are handled', () => {
  assert.ok(analyze(tone(1000, 0.002)).hasContent);
  const boundary = analyze(tone(150));
  assert.ok(Math.abs(total(boundary.bands.map(band => band.energyPercent)) - 100) < 1e-8);
  const limited = analyzeSamples({ sampleRate: 12000, channels: [tone(1000, 1, 0.2, 12000)] });
  assert.equal(limited.bands[7].available, false);
  assert.equal(limited.bands[7].energyPercent, 0);
  assert.equal(limited.bands[6].highHz, 6000);
});

test('progress is monotonic and completes after scanning the full recording', () => {
  const progress = [];
  analyzeSamples({ sampleRate: sr, channels: [tone(100, 2)] }, value => progress.push(value));
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((value, i) => value >= 0 && value <= 1 && (!i || value >= progress[i - 1])));
  assert.ok(progress.some(value => value > 0.2 && value < 1));
});

test('invalid PCM is rejected with a useful error', () => {
  assert.throws(() => analyzeSamples({ sampleRate: sr, channels: [] }), /mono or stereo/);
  assert.throws(() => analyzeSamples({ sampleRate: sr, channels: [tone(100), new Float32Array(2)] }), /equally sized/);
  assert.throws(() => analyzeSamples({ sampleRate: 0, channels: [tone(100)] }), /sample rate/);
  assert.throws(() => analyze(new Float32Array([0, NaN, 0])), /invalid sample/);
});

const summary = analyze(tone(100));
function engineSetup(t, runner) {
  const context = new FakeContext();
  const engine = new AudioEngine(() => context, async () => null, undefined, runner);
  t.after(() => engine.dispose());
  return { engine, context };
}

test('analysis can progress while playback and volume controls remain independent', async (t) => {
  const job = deferred(); let progress, calls = 0;
  const { engine } = engineSetup(t, (_buffer, callback) => { calls++; progress = callback; return job.promise; });
  await engine.loadFile(file('track.wav')); await settle();
  progress(0.4); progress(0.1);
  assert.equal(engine.getSnapshot().analysis.progress, 0.4);
  await engine.play(); engine.setVolume(0.3); engine.setCorrectionEnabled(false);
  assert.equal(engine.getSnapshot().playing, true);
  assert.equal(engine.getSnapshot().analysis.status, 'running');
  job.resolve(summary); await settle();
  assert.equal(engine.getSnapshot().analysis.status, 'ready');
  assert.equal(engine.getSnapshot().analysis.result, summary);
  engine.analyzeTrack(); assert.equal(calls, 1);
});

test('replacing a file aborts analysis and ignores stale progress and results', async (t) => {
  const jobs = [];
  const { engine } = engineSetup(t, (_buffer, progress, signal) => { const job = { ...deferred(), progress, signal }; jobs.push(job); return job.promise; });
  await engine.loadFile(file('first.wav')); await settle();
  await engine.loadFile(file('next.wav')); await settle();
  assert.equal(jobs[0].signal.aborted, true);
  jobs[0].progress(1); jobs[0].resolve(summary); await settle();
  assert.equal(engine.getSnapshot().analysis.status, 'running');
  assert.equal(engine.getSnapshot().analysis.result, null);
  jobs[1].resolve(summary); await settle();
  assert.equal(engine.getSnapshot().track.name, 'next.wav');
  assert.equal(engine.getSnapshot().analysis.status, 'ready');
});

test('cancel and retry affect analysis without interrupting playback', async (t) => {
  const jobs = [];
  const { engine } = engineSetup(t, (_buffer, _progress, signal) => { const job = { ...deferred(), signal }; jobs.push(job); return job.promise; });
  await engine.loadFile(file('track.wav')); await engine.play(); await settle();
  engine.cancelAnalysis();
  assert.equal(jobs[0].signal.aborted, true);
  assert.equal(engine.getSnapshot().analysis.status, 'cancelled');
  assert.equal(engine.getSnapshot().playing, true);
  engine.analyzeTrack(); await settle(); jobs[1].resolve(summary); await settle();
  assert.equal(engine.getSnapshot().analysis.status, 'ready');
  engine.clear();
  assert.equal(engine.getSnapshot().analysis.status, 'idle');
  assert.equal(engine.getSnapshot().analysis.result, null);
});

test('analysis failure remains separate from playback errors and permits retry', async (t) => {
  let attempts = 0;
  const { engine } = engineSetup(t, async () => { if (++attempts === 1) throw new Error('worker failed'); return summary; });
  await engine.loadFile(file('track.wav')); await settle();
  assert.equal(engine.getSnapshot().analysis.status, 'error');
  assert.equal(engine.getSnapshot().error, null);
  await engine.play(); assert.equal(engine.getSnapshot().playing, true);
  engine.analyzeTrack(); await settle();
  assert.equal(engine.getSnapshot().analysis.status, 'ready');
});

test('headphone profiles and playback gain cannot change or rerun a cached analysis', async (t) => {
  let calls = 0;
  const context = new FakeContext();
  const engine = new AudioEngine(() => context, async () => null,
    async (_buffer, _profile, preampDb) => ({ preampDb, originalPeakDb: -10, correctedPeakDb: -8 }),
    async () => { calls++; return summary; });
  t.after(() => engine.dispose());
  await engine.loadFile(file('track.wav')); await settle();
  engine.selectProfile('steelseries-arctis-7-plus'); await settle();
  engine.setCorrectionEnabled(false); engine.setVolume(0.1); engine.selectProfile('none'); await settle();
  assert.equal(calls, 1);
  assert.equal(engine.getSnapshot().analysis.result, summary);
});
