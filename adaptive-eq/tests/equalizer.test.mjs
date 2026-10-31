import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { HEADPHONE_PROFILES, createFilters, measureResponse, responsePreamp, finishPeakCheck, dbToGain, gainToDb, samplePeak } from '../src/audio/equalizer.ts';
import { AudioEngine, correctionIsActive } from '../src/audio/AudioEngine.ts';
import { FakeContext } from './fake-audio.mjs';

const profile = HEADPHONE_PROFILES[0];
const fixture = () => ({ name: 'song.wav', size: 44, arrayBuffer: async () => new ArrayBuffer(44) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup(t, checker = async (_buffer, _profile, preampDb) => ({ preampDb, originalPeakDb: -10, correctedPeakDb: -8 })) {
  const context = new FakeContext();
  const engine = new AudioEngine(() => context, async () => null, checker);
  t.after(() => engine.dispose());
  return { context, engine };
}

test('the bundled profile exactly matches its pinned upstream preset and checksum', async () => {
  const preset = await readFile(new URL('../public/profiles/steelseries-arctis-7-plus-parametric.txt', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(preset).digest('hex'), profile.provenance.sha256);
  assert.match(profile.provenance.commit, /^[a-f0-9]{40}$/);
  assert.ok(profile.provenance.sourceUrl.includes(profile.provenance.commit));
  assert.equal(profile.preampDb, Number(preset.match(/Preamp: ([-\d.]+)/)[1]));
  const types = { PK: 'peaking', LSC: 'lowshelf', HSC: 'highshelf' };
  const parsed = [...preset.matchAll(/ON (PK|LSC|HSC) Fc ([\d.]+) Hz Gain ([-\d.]+) dB Q ([\d.]+)/g)]
    .map(([, type, frequency, gain, q]) => ({ type: types[type], frequency: Number(frequency), gain: Number(gain), q: Number(q) }));
  assert.equal(parsed.length, 10);
  assert.deepEqual(profile.filters, parsed);
});

test('shelves retain preset Q and have the expected DC, midpoint, and Nyquist gains', () => {
  const context = new FakeContext();
  for (const type of ['lowshelf', 'highshelf']) {
    const filter = { type, frequency: 1000, gain: 6, q: 0.7 };
    const [node] = createFilters(context, { ...profile, filters: [filter] });
    assert.ok(node.coefficients, 'shelves must use IIR coefficients because Biquad shelves ignore Q');
    const values = new Float32Array(3);
    node.getFrequencyResponse(new Float32Array([0, 1000, 24000]), values, new Float32Array(3));
    const expected = type === 'lowshelf' ? [6, 3, 0] : [0, 3, 6];
    values.forEach((value, i) => assert.ok(Math.abs(gainToDb(value) - expected[i]) < 0.0001));
  }
});

test('headroom uses the combined response, including overlapping boosts and DC', () => {
  const context = new FakeContext();
  const overlap = { ...profile, preampDb: -1, filters: [1, 2].map(() => ({ type: 'peaking', frequency: 1000, gain: 6, q: 0.7 })) };
  const response = measureResponse(createFilters(context, overlap), 48000);
  assert.ok(response.peakBoostDb > 11.99);
  assert.ok(responsePreamp(overlap, response) < -12.99);
  const actual = measureResponse(createFilters(context, profile), 48000);
  assert.ok(Math.abs(actual.peakBoostDb - 6.7) < 0.001);
  assert.ok(Math.abs(responsePreamp(profile, actual) + 7.7) < 0.001);
  assert.ok(actual.frequencies.every(f => f >= 20 && f <= 20000));
});

test('rendered overshoots cause additional trim and silence remains finite in gain', () => {
  const result = finishPeakCheck(-7.7, 3, 1.2);
  assert.ok(result.preampDb < -7.7);
  assert.ok(result.originalPeakDb <= -1 + 1e-10);
  assert.ok(result.correctedPeakDb <= -1 + 1e-10);
  assert.equal(dbToGain(finishPeakCheck(-7.7, 0, 0).preampDb) > 0, true);
  assert.equal(finishPeakCheck(-7.7, 0, 0).correctedPeakDb, -Infinity);
});

test('sample-peak validation rejects NaN and preserves peaks beyond full scale', () => {
  const audio = values => ({ numberOfChannels: 1, getChannelData: () => Float32Array.from(values) });
  assert.equal(samplePeak(audio([0, -2, 0.5])), 2);
  assert.throws(() => samplePeak(audio([NaN])), /invalid sample/);
});

test('correction waits for its peak check and bypass preserves trim and the live source', async (t) => {
  const checking = deferred();
  const { context, engine } = setup(t, () => checking.promise);
  engine.selectProfile(profile.id);
  const loading = engine.loadFile(fixture());
  await settle();
  assert.equal(engine.getSnapshot().headroom.status, 'checking');
  assert.equal(correctionIsActive(engine.getSnapshot()), false);
  const playing = engine.play();
  await settle();
  assert.equal(context.activeSources.length, 0);
  checking.resolve({ preampDb: -8, originalPeakDb: -10, correctedPeakDb: -7 });
  await loading; await playing;
  assert.equal(correctionIsActive(engine.getSnapshot()), true);
  const source = context.activeSources[0];
  context.currentTime = 5;
  engine.setCorrectionEnabled(false);
  assert.equal(engine.getSnapshot().headroom.preampDb, -8);
  assert.equal(engine.getSnapshot().playing, true);
  assert.equal(context.activeSources[0], source);
  assert.equal(context.gains[3].gain.value, 1);
  assert.equal(context.gains[4].gain.value, 0);
  engine.setCorrectionEnabled(true);
  assert.equal(context.activeSources[0], source);
  assert.equal(context.gains[3].gain.value, 0);
  assert.equal(context.gains[4].gain.value, 1);
  assert.ok(context.gains[4].gain.events.some(event => event[0] === 'ramp'));
});

test('choosing None while a render is pending cannot re-enable an old correction', async (t) => {
  const checking = deferred();
  const { engine } = setup(t, () => checking.promise);
  engine.selectProfile(profile.id);
  const loading = engine.loadFile(fixture());
  await settle();
  engine.selectProfile('none');
  checking.resolve({ preampDb: -9, originalPeakDb: -10, correctedPeakDb: -8 });
  await loading;
  assert.equal(engine.getSnapshot().profileId, 'none');
  assert.equal(correctionIsActive(engine.getSnapshot()), false);
  assert.equal(engine.getSnapshot().headroom.correctedPeakDb, null);
});

test('failed verification falls back to dry playback and can be retried', async (t) => {
  let attempts = 0;
  const { engine } = setup(t, async (_buffer, _profile, preampDb) => {
    if (++attempts === 1) throw new Error('render unavailable');
    return { preampDb, originalPeakDb: -10, correctedPeakDb: -8 };
  });
  engine.selectProfile(profile.id);
  await engine.loadFile(fixture());
  assert.equal(engine.getSnapshot().headroom.status, 'error');
  assert.equal(correctionIsActive(engine.getSnapshot()), false);
  await engine.play();
  assert.equal(engine.getSnapshot().playing, true);
  engine.setCorrectionEnabled(true);
  await settle();
  assert.equal(engine.getSnapshot().headroom.status, 'checked');
  assert.equal(correctionIsActive(engine.getSnapshot()), true);
});

test('verified peaks are reused across bypass and profile toggles but not new files', async (t) => {
  let checks = 0;
  const { engine } = setup(t, async (_buffer, _profile, preampDb) => { checks++; return { preampDb, originalPeakDb: -10, correctedPeakDb: -8 }; });
  engine.selectProfile(profile.id);
  await engine.loadFile(fixture());
  engine.setCorrectionEnabled(false); engine.setCorrectionEnabled(true);
  engine.selectProfile('none'); engine.selectProfile(profile.id);
  await settle();
  assert.equal(checks, 1);
  engine.clear();
  assert.equal(engine.getSnapshot().profileId, profile.id);
  assert.equal(engine.getSnapshot().headroom.status, 'idle');
  await engine.loadFile(fixture());
  assert.equal(checks, 2);
});

test('unsupported profiles cannot change playback configuration', (t) => {
  const { engine } = setup(t);
  engine.selectProfile('marshall-major-v');
  assert.equal(engine.getSnapshot().profileId, 'none');
  assert.equal(engine.getSnapshot().correctionEnabled, false);
});

test('rapid profile toggles reuse an in-flight render instead of allocating more buffers', async (t) => {
  const checking = deferred(); let checks = 0;
  const { engine } = setup(t, () => { checks++; return checking.promise; });
  engine.selectProfile(profile.id);
  const loading = engine.loadFile(fixture());
  await settle();
  for (let i = 0; i < 4; i++) { engine.selectProfile('none'); engine.selectProfile(profile.id); }
  assert.equal(checks, 1);
  checking.resolve({ preampDb: -8, originalPeakDb: -10, correctedPeakDb: -7 });
  await loading; await settle();
  assert.equal(correctionIsActive(engine.getSnapshot()), true);
  assert.equal(engine.getSnapshot().headroom.preampDb, -8);
});
