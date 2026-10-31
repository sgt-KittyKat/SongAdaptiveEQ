import { combinedResponse, createFilters, measureResponse, responseGrid } from './equalizer.ts';
import type { EqFilter, EqResponse, FilterContext, HeadphoneProfile } from './equalizer.ts';
import type { TrackAnalysis, SpectralBand } from './analysis-model.ts';
import { median, smoothOctaves } from './spectral-analysis.ts';
import { fitSongFilters } from './song-fitting.ts';

export const MAX_ADAPTIVE_DELTA_DB = 5;
export const MAX_SONG_FILTER_GAIN_DB = 5;
export const MAX_SONG_STRENGTH = 1.5;
export const MIN_ANALYSIS_SECONDS = 3;
export const MIN_ANALYZED_FRAMES = 16;
export const TONAL_TARGETS = [
  { id: 'balanced', name: 'Balanced', tiltDbPerOctave: -0.2, description: 'Balance the weight of bass, mids, and treble.' },
  { id: 'warm', name: 'Warm', tiltDbPerOctave: -1, description: 'More bass weight and a softer top end.' },
  { id: 'clear', name: 'Clear', tiltDbPerOctave: 0.6, description: 'Less bass weight and a more open top end.' },
] as const;
export type TonalTarget = typeof TONAL_TARGETS[number]['id'];
export interface AdaptiveBand { name: string; lowHz: number; highHz: number; energyPercent: number; activityPercent: number; targetEnergyPercent: number }
export interface AdaptiveChange {
  index: number; name: string; frequency: number; type: string; q: number;
  requestedGainDb: number; adaptiveGainDb: number;
  energyPercent: number; targetEnergyPercent: number; activityPercent: number; reason: string;
}
export interface AdaptivePlan {
  status: 'ready' | 'fallback'; reason: string | null; target: TonalTarget;
  requestedStrength: number; appliedStrength: number; maxDeltaDb: number;
  profile: HeadphoneProfile; response: EqResponse; bands: AdaptiveBand[]; changes: AdaptiveChange[];
  diagnostics?: { referenceFamily: string; character: string; resolutionBands: number; reliableBands: number; tiltDbPerOctave: number | null; contrastDb: number; desiredPeakDb: number; fitErrorDb: number; limited: boolean };
}
export interface AdaptiveState {
  status: 'idle' | 'checking' | 'ready' | 'fallback' | 'error';
  strength: number; target: TonalTarget; plan: AdaptivePlan | null; error: string | null;
}
export const emptyAdaptive = (strength = 1, target: TonalTarget = 'balanced'): AdaptiveState => ({ status: 'idle', strength, target, plan: null, error: null });

/** Explicitly designed power-per-octave target, not an industry music norm. */
export function targetBandPower(low: number, high: number, target: TonalTarget): number {
  const tilt = TONAL_TARGETS.find(item => item.id === target)!.tiltDbPerOctave;
  const octaves = Math.log2(high / low);
  let total = 0;
  for (let i = 0; i < 64; i++) {
    const frequency = low * 2 ** (octaves * (i + 0.5) / 64);
    const rolloff = frequency < 80 ? 6 * Math.log2(frequency / 80) : frequency > 10000 ? -6 * Math.log2(frequency / 10000) : 0;
    total += 10 ** ((tilt * Math.log2(frequency / 1000) + rolloff) / 10);
  }
  return total * octaves / 64;
}

/** Legacy summaries remain usable, but new workers supply 30 robust spectral bands. */
function sourceSpectrum(analysis: TrackAnalysis): SpectralBand[] {
  if (analysis.spectral) return analysis.spectral.bands.filter(b => b.available);
  return analysis.bands.filter(b => b.available).map(band => ({ ...band, frequency: Math.sqrt(band.lowHz * band.highHz),
    robustPower: band.energyPercent / 100, densityDb: 10 * Math.log10(Math.max(1e-10, band.energyPercent / 100 / Math.log2(band.highHz / band.lowHz))),
    spreadDb: 0, contrastDb: 0, reliability: band.energyPercent > 0 ? 0.65 : 0, localDeviationDb: 0 }));
}
function weightedCenter(values: number[], weights: number[]): number {
  const sorted = values.map((value, i) => ({ value, weight: weights[i] })).sort((a, b) => a.value - b.value);
  const halfway = weights.reduce((a, b) => a + b, 0) / 2;
  let sum = 0; for (const item of sorted) { sum += item.weight; if (sum >= halfway) return item.value; }
  return 0;
}

/** Preserve device calibration and fit a separate, content-aware song response. */
export function createAdaptivePlan(context: FilterContext, profile: HeadphoneProfile, measured: EqResponse, analysis: TrackAnalysis | null, strength: number, target: TonalTarget = 'balanced'): AdaptivePlan {
  strength = Number.isFinite(strength) ? Math.max(0, Math.min(MAX_SONG_STRENGTH, strength)) : 0;
  if (!TONAL_TARGETS.some(item => item.id === target)) target = 'balanced';
  const unchanged = (reason: string | null, status: 'ready' | 'fallback' = 'fallback'): AdaptivePlan => ({ status, reason, target, requestedStrength: strength, appliedStrength: 0, maxDeltaDb: 0, profile, response: measured, bands: [], changes: [] });
  if (strength === 0) return unchanged('Zero strength reproduces measured correction exactly.', 'ready');
  if (!analysis) return unchanged('Waiting for a completed track analysis. Measured correction is in use.');
  if (!analysis.hasContent) return unchanged('No measurable frequency content. Measured correction is in use.');
  if (!Number.isFinite(analysis.duration) || !Number.isFinite(analysis.analyzedFrames) || analysis.duration < MIN_ANALYSIS_SECONDS || analysis.analyzedFrames < MIN_ANALYZED_FRAMES) return unchanged('At least 3 seconds and 16 analyzed frames are needed. Measured correction is in use.');
  const available = analysis.bands.filter(b => b.available);
  if (!available.length || available.some(b => ![b.energyPercent, b.activityPercent, b.lowHz, b.highHz].every(Number.isFinite) || b.energyPercent < 0 || b.activityPercent < 0 || b.lowHz <= 0 || b.highHz <= b.lowHz)) return unchanged('The analysis is incomplete. Measured correction is in use.');
  const spectrum = sourceSpectrum(analysis);
  if (!spectrum.length || spectrum.some(b => ![b.frequency, b.densityDb, b.robustPower, b.reliability, b.spreadDb, b.contrastDb, b.localDeviationDb].every(Number.isFinite) || b.robustPower < 0 || b.reliability < 0 || b.reliability > 1) || spectrum.reduce((a, b) => a + b.robustPower, 0) <= 0) return unchanged('The detailed spectrum is unavailable or invalid. Measured correction is in use.');
  const reliable = spectrum.filter(b => b.reliability >= 0.25 && b.robustPower > 1e-6);
  if (analysis.spectral && reliable.length < 7) return unchanged('Too little persistent broadband content to infer a useful song EQ. Measured correction is in use.');
  const frequencies = spectrum.map(b => b.frequency), source = spectrum.map(b => b.densityDb);
  const evidence = spectrum.map(b => b.robustPower > 1e-6 ? b.reliability : 0);
  const reference = spectrum.map(b => 10 * Math.log10(targetBandPower(b.lowHz, b.highHz, target) / Math.log2(b.highHz / b.lowHz)));
  // Remove one overall level offset; spectral tilt and regional differences survive.
  const alignWeights = evidence.map((w, i) => frequencies[i] >= 70 && frequencies[i] <= 12000 ? w : 0);
  const offset = weightedCenter(source.map((v, i) => v - reference[i]), alignWeights);
  const deviation = source.map((v, i) => v - reference[i] - offset);
  const average = (low: number, high: number) => {
    const values = deviation.filter((_, i) => frequencies[i] >= low && frequencies[i] <= high && evidence[i] >= 0.2);
    return values.length ? median(values) : 0;
  };
  const mid = average(400, 2000), bass = average(50, 200) - mid, top = average(4000, 12000) - mid;
  const presence = average(1500, 4000) - (average(350, 900) + average(6000, 12000)) / 2;
  const body = average(300, 1000) - (average(60, 180) + average(2500, 7000)) / 2;
  const candidates = [
    { name: 'Bass-rich', value: bass, center: 100, width: 1.6, sign: 1 },
    { name: 'Bright', value: top, center: 7000, width: 1.8, sign: 1 },
    { name: 'Dark', value: -top, center: 7000, width: 1.8, sign: -1 },
    { name: 'Presence-led', value: presence * 1.25, center: 2300, width: 1, sign: 1 },
    { name: 'Mid-focused', value: body * 1.25, center: 650, width: 1.1, sign: 1 },
  ].sort((a, b) => b.value - a.value);
  const family = candidates[0].value > 3 ? candidates[0] : null;
  // A small family allowance retains intentional broad character without following it wholesale.
  const familyReference = reference.map((v, i) => v + (family ? family.sign * 1.5 * Math.exp(-0.5 * (Math.log2(frequencies[i] / family.center) / family.width) ** 2) : 0));
  const familyOffset = weightedCenter(source.map((v, i) => v - familyReference[i]), alignWeights);
  const broadSource = smoothOctaves(frequencies, source, evidence, 0.42);
  const maxDensity = Math.max(...spectrum.filter(b => b.reliability >= 0.25).map(b => b.densityDb));
  const desired = spectrum.map((band, i) => {
    if (evidence[i] <= 0 || band.densityDb < maxDensity - 35) return 0;
    let error = familyReference[i] + familyOffset - broadSource[i];
    // Persistent broad local resonances get some attention; harmonic peaks and holes do not.
    if (band.contrastDb < 18 && band.reliability > 0.5) error -= Math.max(-2, Math.min(2, band.localDeviationDb)) * 0.35;
    const tolerance = 0.6 + (1 - band.reliability) * 0.9;
    const departure = Math.sign(error) * Math.max(0, Math.abs(error) - tolerance);
    const magnitude = 0.55 + 0.45 * Math.min(1, Math.abs(error) / 4);
    let confidence = Math.sqrt(band.reliability) * magnitude;
    // Boosts require persistent content, rather than a fixed percentage of total song power.
    if (departure > 0) confidence *= Math.min(1, band.activityPercent / 65);
    const raw = departure * confidence * strength;
    return MAX_ADAPTIVE_DELTA_DB * Math.tanh(raw / MAX_ADAPTIVE_DELTA_DB);
  });
  const fitWeights = evidence.map((w, i) => w * (spectrum[i].densityDb >= maxDensity - 35 ? 1 : 0));
  const fit = fitSongFilters(context, profile, frequencies, desired, fitWeights, MAX_ADAPTIVE_DELTA_DB);
  if (fit.peakDb < 0.12 || !fit.filters.length) return unchanged('The reliable spectrum is already within the chosen reference range.', 'ready');
  const adapted: HeadphoneProfile = { ...profile, id: `${profile.id}:robust-song:${target}:${fit.filters.map(f => [f.type, f.frequency.toPrecision(10), f.q.toPrecision(10), f.gain.toPrecision(10)].join('/')).join(',')}`, filters: [...profile.filters, ...fit.filters] };
  const nodes = createFilters(context, adapted), response = measureResponse(nodes, context.sampleRate); nodes.forEach(node => node.disconnect());
  const targetPowers = familyReference.map((db, i) => 10 ** (db / 10) * Math.log2(spectrum[i].highHz / spectrum[i].lowHz));
  const targetTotal = targetPowers.reduce((a, b) => a + b, 0), sourceTotal = spectrum.reduce((a, b) => a + b.robustPower, 0);
  const bands: AdaptiveBand[] = spectrum.map((b, i) => ({ name: `${Math.round(b.frequency)} Hz`, lowHz: b.lowHz, highHz: b.highHz, energyPercent: b.robustPower / sourceTotal * 100, activityPercent: b.activityPercent, targetEnergyPercent: targetPowers[i] / targetTotal * 100 }));
  return { status: 'ready', reason: null, target, requestedStrength: strength, appliedStrength: strength * fit.amount, maxDeltaDb: fit.peakDb, profile: adapted, response, bands,
    diagnostics: { referenceFamily: family?.name ?? 'Balanced', character: family?.name ?? 'Broadly balanced', resolutionBands: spectrum.length, reliableBands: reliable.length, tiltDbPerOctave: analysis.spectral?.tiltDbPerOctave ?? null, contrastDb: analysis.spectral?.contrastDb ?? 0, desiredPeakDb: Math.max(...desired.map(Math.abs)), fitErrorDb: fit.fitErrorDb, limited: fit.amount < 0.999 },
    changes: fit.filters.map((filter, index) => {
      const nearest = frequencies.reduce((best, f, i) => Math.abs(Math.log2(f / filter.frequency)) < Math.abs(Math.log2(frequencies[best] / filter.frequency)) ? i : best, 0);
      const band = spectrum[nearest];
      return { index: index + 1, name: filter.frequency < 160 ? 'Bass' : filter.frequency < 450 ? 'Body' : filter.frequency < 1600 ? 'Midrange' : filter.frequency < 5000 ? 'Presence' : 'Treble',
        frequency: filter.frequency, type: filter.type, q: filter.q, requestedGainDb: filter.gain / Math.max(fit.amount, 1e-9), adaptiveGainDb: filter.gain,
        energyPercent: bands[nearest].energyPercent, targetEnergyPercent: bands[nearest].targetEnergyPercent, activityPercent: band.activityPercent,
        reason: `${Math.round(band.reliability * 100)}% spectral confidence; fitted to the ${family?.name.toLowerCase() ?? 'balanced'} reference family.`,
      };
    }) };
}
