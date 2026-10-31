import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdaptivePlan, targetBandPower, TONAL_TARGETS, MAX_ADAPTIVE_DELTA_DB } from '../src/audio/adaptive.ts';
import { HEADPHONE_PROFILES, createFilters, measureResponse, combinedResponse, responseGrid, EqualizerChain } from '../src/audio/equalizer.ts';
import { AudioEngine, effectivePlaybackMode } from '../src/audio/AudioEngine.ts';
import { FakeContext } from './fake-audio.mjs';
import { analysisFixture } from './adaptive-fixture.ts';

const profile = HEADPHONE_PROFILES[0];
const measured = context => measureResponse(createFilters(context, profile), context.sampleRate);
const fixture = () => ({ name: 'song.wav', size: 44, arrayBuffer: async () => new ArrayBuffer(44) });
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const peakResult = (preampDb = -8) => ({ preampDb, originalPeakDb: -10, correctedPeakDb: -4 });
function setup(t, checker = async () => peakResult(), runner = async () => analysisFixture()) {
  const context = new FakeContext();
  const engine = new AudioEngine(() => context, async () => null, checker, runner);
  t.after(() => engine.dispose());
  return { context, engine };
}
async function ready(engine) { await engine.loadFile(fixture()); engine.selectProfile(profile.id); await settle(); }

test('zero strength uses the exact measured profile and response without mutating the preset', () => {
  const context = new FakeContext(), response = measured(context), original = structuredClone(profile);
  const plan = createAdaptivePlan(context, profile, response, analysisFixture(), 0);
  assert.equal(plan.profile, profile); assert.equal(plan.response, response);
  assert.equal(plan.maxDeltaDb, 0); assert.equal(plan.status, 'ready');
  createAdaptivePlan(context, profile, response, analysisFixture(), 1);
  assert.deepEqual(profile, original);
});

test('missing, silent, short, insufficient, invalid and unavailable analysis fall back exactly', () => {
  const context = new FakeContext(), response = measured(context), summary = analysisFixture();
  for (const input of [null, { ...summary, hasContent: false }, { ...summary, duration: 2.9 }, { ...summary, analyzedFrames: 15 },
    { ...summary, bands: summary.bands.map(b => ({ ...b, energyPercent: NaN })) },
    { ...summary, bands: summary.bands.map(b => ({ ...b, available: false })) }]) {
    const plan = createAdaptivePlan(context, profile, response, input, 1);
    assert.equal(plan.status, 'fallback'); assert.equal(plan.profile, profile); assert.equal(plan.response, response); assert.ok(plan.reason);
  }
});

test('track shaping preserves the entire headphone calibration and adds broad bounded filters', () => {
  const context = new FakeContext(), response = measured(context);
  const bass = createAdaptivePlan(context, profile, response, analysisFixture(1), 1);
  const treble = createAdaptivePlan(context, profile, response, analysisFixture(6), 1);
  assert.notDeepEqual(bass.profile.filters, treble.profile.filters);
  for (const plan of [bass, treble]) {
    assert.deepEqual(plan.profile.filters.slice(0, profile.filters.length), profile.filters);
    const song = plan.profile.filters.slice(profile.filters.length);
    assert.ok(song.length > 0 && song.length <= 8);
    assert.ok(song.every(filter => Math.abs(filter.gain) <= 5 && filter.q <= 1.35));
    assert.ok(plan.maxDeltaDb <= MAX_ADAPTIVE_DELTA_DB);
  }
});

test('a recording on the tonal target retains measured correction exactly', () => {
  const context = new FakeContext(), response = measured(context), input = analysisFixture();
  const powers = input.bands.map(b => targetBandPower(b.lowHz, b.highHz, 'balanced'));
  const total = powers.reduce((a, b) => a + b, 0);
  input.bands.forEach((b, i) => { b.energyPercent = powers[i] / total * 100; b.activityPercent = 100; });
  const plan = createAdaptivePlan(context, profile, response, input, 1);
  assert.equal(plan.profile, profile); assert.equal(plan.response, response); assert.equal(plan.maxDeltaDb, 0);
});

test('the full combined song layer stays within 5 dB, including overlapping filters, DC and Nyquist', () => {
  const context = new FakeContext();
  const base = measured(context), input = analysisFixture();
  const energies = [42, 42, 2, 2, 2, 2, 4, 4];
  input.bands.forEach((b, i) => { b.energyPercent = energies[i]; b.activityPercent = 100; });
  const plan = createAdaptivePlan(context, profile, base, input, 1);
  assert.ok(plan.appliedStrength > 0);
  const grid = responseGrid(context.sampleRate);
  const before = combinedResponse(createFilters(context, profile), grid), after = combinedResponse(createFilters(context, plan.profile), grid);
  const actual = Math.max(...after.map((gain, i) => Math.abs(gain - before[i])));
  assert.equal(grid[0], 0); assert.equal(grid.at(-1), 24000);
  assert.ok(actual <= 5); assert.ok(Math.abs(actual - plan.maxDeltaDb) < 1e-8);
});

test('warm and clear references produce different directional song shaping', () => {
  const context = new FakeContext(), response = measured(context), input = analysisFixture();
  input.bands.forEach(b => { b.energyPercent = 12.5; b.activityPercent = 100; });
  const warm = createAdaptivePlan(context, profile, response, input, 1, 'warm');
  const clear = createAdaptivePlan(context, profile, response, input, 1, 'clear');
  assert.notEqual(warm.profile.id, clear.profile.id);
  assert.ok(warm.changes[0].adaptiveGainDb > clear.changes[0].adaptiveGainDb);
  assert.ok(warm.changes.at(-1).adaptiveGainDb < clear.changes.at(-1).adaptiveGainDb);
  for (const target of TONAL_TARGETS) {
    const plan = createAdaptivePlan(context, profile, response, input, 1, target.id);
    assert.ok(Math.abs(plan.bands.reduce((sum, b) => sum + b.targetEnergyPercent, 0) - 100) < 1e-8);
  }
});

test('absent and inactive frequency regions are not boosted', () => {
  const context = new FakeContext(), input = analysisFixture(), response = measured(context);
  input.bands.forEach((b, i) => { b.energyPercent = i === 1 ? 100 : 0; b.activityPercent = i === 1 ? 100 : 0; });
  const plan = createAdaptivePlan(context, profile, response, input, 1);
  assert.ok(plan.changes.filter(c => c.energyPercent === 0).every(c => c.adaptiveGainDb === 0));
});

test('the song layer is independent of source gain, and device selection still changes the final EQ', () => {
  const context = new FakeContext(), input = analysisFixture(), response = measured(context);
  const louder = { ...input, rmsDbfs: input.rmsDbfs + 10, samplePeakDbfs: input.samplePeakDbfs + 10 };
  const plan = createAdaptivePlan(context, profile, response, input, 1);
  assert.deepEqual(createAdaptivePlan(context, profile, response, louder, 1).profile.filters, plan.profile.filters);
  const other = { ...profile, id: 'synthetic-device', filters: profile.filters.map(f => ({ ...f, gain: f.gain / 2 })) };
  const otherPlan = createAdaptivePlan(context, other, measureResponse(createFilters(context, other), context.sampleRate), input, 1);
  assert.deepEqual(otherPlan.profile.filters.slice(other.filters.length), plan.profile.filters.slice(profile.filters.length));
  assert.notDeepEqual(otherPlan.profile.filters, plan.profile.filters);
});

test('verified adaptive mode switches all three branches without restarting the source', async t => {
  const { context, engine } = setup(t); await ready(engine); await engine.play();
  const source = context.activeSources[0], count = context.sources.length, trim = engine.getSnapshot().headroom.preampDb;
  for (const [mode, gains] of [['adaptive', [0, 0, 1]], ['bypass', [1, 0, 0]], ['corrected', [0, 1, 0]]]) {
    engine.setPlaybackMode(mode);
    assert.equal(effectivePlaybackMode(engine.getSnapshot()), mode);
    assert.deepEqual(context.gains.slice(3, 6).map(n => n.gain.value), gains);
    assert.equal(context.activeSources[0], source); assert.equal(context.sources.length, count);
    assert.equal(engine.getSnapshot().headroom.preampDb, trim);
  }
});

test('new strength is never applied until its peak render succeeds; zero uses the measured branch', async t => {
  const gate = deferred(); let checks = 0;
  const { context, engine } = setup(t, async () => ++checks <= 2 ? peakResult() : gate.promise);
  await ready(engine); engine.setPlaybackMode('adaptive');
  const old = engine.getSnapshot().adaptive.plan;
  engine.setAdaptiveStrength(0.5); await settle();
  assert.equal(engine.getSnapshot().adaptive.status, 'checking'); assert.equal(engine.getSnapshot().adaptive.plan, old);
  assert.equal(effectivePlaybackMode(engine.getSnapshot()), 'adaptive');
  gate.resolve(peakResult(-11)); await settle();
  assert.equal(engine.getSnapshot().adaptive.plan.requestedStrength, 0.5);
  assert.equal(engine.getSnapshot().headroom.preampDb, -11);
  engine.setAdaptiveStrength(0); await settle();
  assert.equal(effectivePlaybackMode(engine.getSnapshot()), 'corrected');
  assert.equal(context.gains[4].gain.value, 1); assert.equal(context.gains[5].gain.value, 0);
  assert.equal(engine.getSnapshot().headroom.preampDb, -11);
});

test('obsolete strength checks cannot commit and rapid requests render only the latest next setting', async t => {
  const gate = deferred(); let checks = 0;
  const { engine } = setup(t, async () => ++checks <= 2 ? peakResult() : checks === 3 ? gate.promise : peakResult());
  await ready(engine); const old = engine.getSnapshot().adaptive.plan;
  engine.setAdaptiveStrength(0.2); await settle();
  engine.setAdaptiveStrength(0.4); engine.setAdaptiveStrength(0.6); engine.setAdaptiveStrength(0.8);
  assert.equal(engine.getSnapshot().adaptive.plan, old);
  gate.resolve(peakResult(-20)); await settle();
  assert.equal(checks, 4); assert.equal(engine.getSnapshot().adaptive.plan.requestedStrength, 0.8);
  assert.notEqual(engine.getSnapshot().headroom.preampDb, -20);
});

test('failed adaptive checks retain verified settings and retry without a playback error', async t => {
  let checks = 0;
  const { engine } = setup(t, async () => { if (++checks === 3) throw new Error('Render failed'); return peakResult(); });
  await ready(engine); engine.setPlaybackMode('adaptive'); const old = engine.getSnapshot().adaptive.plan;
  engine.setAdaptiveStrength(0.5); await settle();
  assert.equal(engine.getSnapshot().adaptive.status, 'error'); assert.equal(engine.getSnapshot().adaptive.plan, old);
  assert.equal(effectivePlaybackMode(engine.getSnapshot()), 'adaptive'); assert.equal(engine.getSnapshot().error, null);
  engine.retryAdaptive(); await settle();
  assert.equal(engine.getSnapshot().adaptive.status, 'ready'); assert.equal(engine.getSnapshot().adaptive.plan.requestedStrength, 0.5);
});

test('target changes are peak-checked and survive track replacement without rerunning cached analysis', async t => {
  let analyses = 0;
  const { engine } = setup(t, undefined, async () => { analyses++; const input = analysisFixture(); input.bands.forEach(b => { b.energyPercent = 12.5; b.activityPercent = 100; }); return input; });
  await ready(engine); engine.setTonalTarget('warm'); await settle();
  assert.equal(engine.getSnapshot().adaptive.plan.target, 'warm'); assert.equal(analyses, 1);
  engine.setTonalTarget('invalid'); assert.equal(engine.getSnapshot().adaptive.target, 'warm');
  await engine.loadFile(fixture()); await settle();
  assert.equal(engine.getSnapshot().adaptive.target, 'warm'); assert.equal(engine.getSnapshot().adaptive.plan.target, 'warm');
});

test('track replacement invalidates adaptive renders and cache across files', async t => {
  const gate = deferred(); let checks = 0;
  const { engine } = setup(t, async () => ++checks === 2 ? gate.promise : peakResult());
  await ready(engine); assert.equal(engine.getSnapshot().adaptive.status, 'checking');
  await engine.loadFile({ ...fixture(), name: 'replacement.wav' });
  gate.resolve(peakResult(-25)); await settle();
  assert.equal(engine.getSnapshot().track.name, 'replacement.wav');
  assert.equal(engine.getSnapshot().adaptive.status, 'ready'); assert.ok(checks >= 4);
  assert.notEqual(engine.getSnapshot().headroom.preampDb, -25);
});

test('silent analysis uses measured correction when Adaptive is requested', async t => {
  const { engine } = setup(t, undefined, async () => ({ ...analysisFixture(), hasContent: false }));
  await ready(engine); engine.setPlaybackMode('adaptive');
  assert.equal(engine.getSnapshot().adaptive.status, 'fallback');
  assert.equal(effectivePlaybackMode(engine.getSnapshot()), 'corrected');
});

test('replacing a live adaptive branch fades it out, then disconnects it when paused', () => {
  const context = new FakeContext(), input = context.createGain(), output = context.createGain();
  const chain = new EqualizerChain(context, input, output); chain.install(profile);
  const first = createAdaptivePlan(context, profile, measured(context), analysisFixture(), 1);
  chain.installAdaptive(first.profile); chain.apply('adaptive', -9, true);
  const old = context.gains[5];
  const second = createAdaptivePlan(context, profile, measured(context), analysisFixture(), 0.5);
  chain.installAdaptive(second.profile); chain.apply('adaptive', -10, true);
  assert.ok(old.gain.events.some(event => event[0] === 'ramp' && event[1] === 0));
  assert.ok(old.connections.length > 0);
  chain.apply('corrected', -10, false); assert.equal(old.connections.length, 0); chain.dispose();
});
