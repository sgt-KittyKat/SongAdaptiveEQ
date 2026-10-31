import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSamples } from '../src/audio/track-analysis.ts';
import { createAdaptivePlan } from '../src/audio/adaptive.ts';
import { HEADPHONE_PROFILES, createFilters, measureResponse, combinedResponse, responseGrid } from '../src/audio/equalizer.ts';
import { FakeContext } from './fake-audio.mjs';
import { songFixture, SONG_FIXTURES } from './song-fixtures.ts';

const rate = 48000, profile = HEADPHONE_PROFILES[0], context = new FakeContext();
const base = measureResponse(createFilters(context, profile), rate);
const data = new Map(), summaries = new Map(), plans = new Map();
const pcm = kind => { if (!data.has(kind)) data.set(kind, songFixture(kind)); return data.get(kind); };
const analyze = samples => analyzeSamples({ sampleRate: rate, channels: [samples] });
const summary = kind => { if (!summaries.has(kind)) summaries.set(kind, analyze(pcm(kind))); return summaries.get(kind); };
const plan = kind => { if (!plans.has(kind)) plans.set(kind, createAdaptivePlan(context, profile, base, summary(kind), 1)); return plans.get(kind); };
const response = (p, frequencies) => Array.from(combinedResponse(createFilters(context, { ...profile, filters: p.profile.filters.slice(profile.filters.length) }), Float32Array.from(frequencies)));

test('analysis retains a robust 30-band spectrum, tilt, contrast, local detail and temporal reliability', () => {
  const result = summary('balanced');
  assert.equal(result.version, 2); assert.equal(result.spectral.bands.length, 30);
  assert.equal(result.fftSize, 16384); assert.equal(result.frequencyResolutionHz, rate / 16384);
  assert.equal(result.spectral.aggregation, 'frame-normalized-trimmed-power');
  assert.ok(Number.isFinite(result.spectral.tiltDbPerOctave)); assert.ok(result.spectral.contrastDb > 0);
  assert.ok(result.spectral.bands.filter(b => b.reliability > 0.5).length > 20);
  assert.ok(Math.abs(result.spectral.bands.reduce((sum, b) => sum + b.robustPower, 0) - 1) < 1e-8);
});

test('bass-heavy/light and bright/dark passages receive distinct, appropriate response directions', () => {
  const bass = response(plan('bass-heavy'), [125])[0], light = response(plan('bass-light'), [125])[0];
  const bright = response(plan('bright'), [8000])[0], dark = response(plan('dark'), [8000])[0];
  assert.ok(bass < -2.5 && light > 2, `bass ${bass}, light ${light}`);
  assert.ok(bright < -0.9 && dark > 2.5, `bright ${bright}, dark ${dark}`);
  assert.ok(bass - light < -5 && bright - dark < -3);
});

test('mid and vocal-range emphasis shift the fitted correction to different frequency regions', () => {
  const mids = plan('mid-focused'), presence = plan('presence-led');
  assert.equal(mids.diagnostics.referenceFamily, 'Mid-focused');
  assert.equal(presence.diagnostics.referenceFamily, 'Presence-led');
  const a = response(mids, [650, 2400]), b = response(presence, [650, 2400]);
  assert.ok(a[0] < a[1] - 1); assert.ok(b[1] < b[0] - 1);
});

test('localized broad emphasis inside the old merged midrange creates different fitted responses', () => {
  const a = plan('peak-700'), b = plan('peak-1800');
  const first = response(a, [700, 1800]), second = response(b, [700, 1800]);
  assert.ok(first[0] < second[0] - 0.4); assert.ok(second[1] < first[1] - 0.4);
  assert.notDeepEqual(a.profile.filters.slice(10).map(f => f.frequency), b.profile.filters.slice(10).map(f => f.frequency));
});

test('a brief loud treble transient cannot steer the full-track song EQ', () => {
  const original = pcm('bass-heavy'), burst = original.slice();
  for (let i = rate * 2; i < rate * 2.06; i++) burst[i] += 0.85 * Math.sin(2 * Math.PI * 7000 * i / rate);
  const changed = createAdaptivePlan(context, profile, base, analyze(burst), 1);
  const grid = Array.from({ length: 80 }, (_, i) => 30 * (16000 / 30) ** (i / 79));
  const originalCurve = response(plan('bass-heavy'), grid), burstCurve = response(changed, grid);
  const difference = Math.max(...originalCurve.map((v, i) => Math.abs(v - burstCurve[i])));
  assert.ok(difference < 0.45, `max difference ${difference} dB`);
});

test('source gain changes neither robust spectral features nor the resulting song curve', () => {
  const quieter = analyze(Float32Array.from(pcm('dark'), v => v * 0.01)), original = summary('dark');
  original.spectral.bands.forEach((b, i) => assert.ok(Math.abs(b.densityDb - quieter.spectral.bands[i].densityDb) < 0.002));
  const changed = createAdaptivePlan(context, profile, base, quieter, 1);
  const a = response(plan('dark'), [100, 500, 2000, 8000]), b = response(changed, [100, 500, 2000, 8000]);
  assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 0.02));
});

test('a balanced passage stays mild and isolated tones do not get forced toward a full-mix reference', () => {
  assert.ok(plan('balanced').maxDeltaDb < 1.5);
  const tone = Float32Array.from({ length: rate * 4 }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 1000 * i / rate));
  const sparse = createAdaptivePlan(context, profile, base, analyze(tone), 1);
  assert.equal(sparse.status, 'fallback'); assert.equal(sparse.profile, profile);
});

test('native-response fitting preserves meaningful goals, device calibration, and the full-range bound', () => {
  for (const kind of SONG_FIXTURES) {
    const p = plan(kind);
    assert.deepEqual(p.profile.filters.slice(0, profile.filters.length), profile.filters);
    assert.ok(p.diagnostics.fitErrorDb < 0.7, `${kind}: ${p.diagnostics.fitErrorDb}`);
    if (kind !== 'balanced') assert.ok(p.maxDeltaDb > p.diagnostics.desiredPeakDb * 0.6);
    for (const strength of [0.5, 1.5]) {
      const altered = createAdaptivePlan(context, profile, base, summary(kind), strength);
      if (altered.profile === profile) continue;
      const full = response(altered, responseGrid(rate));
      assert.ok(Math.max(...full.map(Math.abs)) <= 5);
      assert.ok(altered.profile.filters.slice(10).every(f => Math.abs(f.gain) <= 5 && f.q <= 1.35));
    }
  }
});

test('identical input is deterministic and small level-preserving perturbations do not invent a new curve', () => {
  const original = plan('bright');
  assert.deepEqual(createAdaptivePlan(context, profile, base, summary('bright'), 1).profile.filters, original.profile.filters);
  const altered = analyze(Float32Array.from(pcm('bright'), (v, i) => v * (1 + 0.002 * Math.sin(i / 1234))));
  const changed = createAdaptivePlan(context, profile, base, altered, 1);
  const a = response(original, [100, 500, 2000, 8000]), b = response(changed, [100, 500, 2000, 8000]);
  assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 0.1));
});
