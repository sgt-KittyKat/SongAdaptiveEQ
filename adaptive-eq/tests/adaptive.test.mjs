import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdaptivePlan } from '../src/audio/adaptive.ts';
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

test('track content changes gains toward zero within 70–100%, preserving frequencies, Q and polarity', () => {
  const context = new FakeContext(), response = measured(context);
  const bass = createAdaptivePlan(context, profile, response, analysisFixture(1), 1);
  const treble = createAdaptivePlan(context, profile, response, analysisFixture(6), 1);
  assert.notDeepEqual(bass.profile.filters, treble.profile.filters);
  for (const plan of [bass, treble]) for (const [i, filter] of plan.profile.filters.entries()) {
    const base = profile.filters[i];
    assert.equal(filter.frequency, base.frequency); assert.equal(filter.q, base.q); assert.equal(filter.type, base.type);
    assert.ok(filter.gain / base.gain >= 0.7 - 1e-12 && filter.gain / base.gain <= 1);
  }
});

test('all-high relevance retains full correction and reported statistics match input', () => {
  const context = new FakeContext(), response = measured(context), input = analysisFixture();
  input.bands.forEach(b => { b.energyPercent = 12.5; b.activityPercent = 100; });
  const plan = createAdaptivePlan(context, profile, response, input, 1);
  assert.deepEqual(plan.profile.filters, profile.filters); assert.ok(plan.maxDeltaDb < 1e-5);
  assert.equal(plan.bands[0].energyPercent, 12.5); assert.equal(plan.bands[0].relevance, 1);
});

test('overlapping filters trigger the combined 2 dB bound, including DC and Nyquist', () => {
  const context = new FakeContext();
  const overlapping = { ...profile, filters: [
    { type: 'lowshelf', frequency: 300, gain: 20, q: 0.7 },
    { type: 'lowshelf', frequency: 300, gain: 20, q: 0.7 },
  ] };
  const base = measureResponse(createFilters(context, overlapping), context.sampleRate);
  const plan = createAdaptivePlan(context, overlapping, base, analysisFixture(7), 1);
  assert.ok(plan.appliedStrength > 0 && plan.appliedStrength < 1);
  const grid = responseGrid(context.sampleRate);
  const before = combinedResponse(createFilters(context, overlapping), grid), after = combinedResponse(createFilters(context, plan.profile), grid);
  const actual = Math.max(...after.map((gain, i) => Math.abs(gain - before[i])));
  assert.equal(grid[0], 0); assert.equal(grid.at(-1), 24000);
  assert.ok(actual <= 2); assert.ok(Math.abs(actual - plan.maxDeltaDb) < 1e-8);
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
