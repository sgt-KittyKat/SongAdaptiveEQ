import { combinedResponse, createFilters, measureResponse, responseGrid } from './equalizer.ts';
import type { EqResponse, FilterContext, HeadphoneProfile } from './equalizer.ts';
import type { TrackAnalysis } from './analysis-model.ts';

export const MAX_ADAPTIVE_DELTA_DB = 2;
export const MIN_RETAINED_CORRECTION = 0.7;
export const MIN_ANALYSIS_SECONDS = 3;
export const MIN_ANALYZED_FRAMES = 16;
export interface AdaptiveBand { name: string; lowHz: number; highHz: number; energyPercent: number; activityPercent: number; relevance: number }
export interface AdaptiveChange { index: number; frequency: number; type: string; q: number; baseGainDb: number; adaptiveGainDb: number; relevance: number; retainedPercent: number }
export interface AdaptivePlan {
  status: 'ready' | 'fallback'; reason: string | null;
  requestedStrength: number; appliedStrength: number; maxDeltaDb: number;
  profile: HeadphoneProfile; response: EqResponse; bands: AdaptiveBand[]; changes: AdaptiveChange[];
}
export interface AdaptiveState {
  status: 'idle' | 'checking' | 'ready' | 'fallback' | 'error';
  strength: number; plan: AdaptivePlan | null; error: string | null;
}
export const emptyAdaptive = (strength = 1): AdaptiveState => ({ status: 'idle', strength, plan: null, error: null });

/** A deterministic content-relevance heuristic, not a prediction of listener preference. */
export function createAdaptivePlan(context: FilterContext, profile: HeadphoneProfile, measured: EqResponse, analysis: TrackAnalysis | null, strength: number): AdaptivePlan {
  strength = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
  const unchanged = (reason: string | null, status: 'ready' | 'fallback' = 'fallback'): AdaptivePlan => ({ status, reason, requestedStrength: strength, appliedStrength: 0, maxDeltaDb: 0, profile, response: measured, bands: [], changes: [] });
  if (strength === 0) return unchanged('Zero strength reproduces measured correction exactly.', 'ready');
  if (!analysis) return unchanged('Waiting for a completed track analysis. Measured correction is in use.');
  if (!analysis.hasContent) return unchanged('No measurable frequency content. Measured correction is in use.');
  if (analysis.duration < MIN_ANALYSIS_SECONDS || analysis.analyzedFrames < MIN_ANALYZED_FRAMES) return unchanged('At least 3 seconds and 16 analyzed frames are needed. Measured correction is in use.');
  const valid = analysis.bands.filter(band => band.available);
  if (!valid.length || valid.some(band => ![band.energyPercent, band.activityPercent, band.lowHz, band.highHz].every(Number.isFinite) || band.energyPercent < 0 || band.activityPercent < 0 || band.highHz <= band.lowHz)) return unchanged('The analysis is incomplete. Measured correction is in use.');
  const largestEnergy = Math.max(...valid.map(band => band.energyPercent));
  if (largestEnergy <= 0) return unchanged('No measured band energy. Measured correction is in use.');
  const bands: AdaptiveBand[] = valid.map(band => ({ name: band.name, lowHz: band.lowHz, highHz: band.highHz, energyPercent: band.energyPercent, activityPercent: band.activityPercent,
    relevance: Math.max(0, Math.min(1, 0.5 * Math.sqrt(band.energyPercent / largestEnergy) + 0.5 * band.activityPercent / 100)) }));
  const grid = responseGrid(context.sampleRate);
  const baselineNodes = createFilters(context, profile);
  const baseline = combinedResponse(baselineNodes, grid);
  // Weight each filter by its actual affected region, including the shelf's range.
  // The log-spaced grid gives approximately equal weight to equal octave spans.
  const relevances = baselineNodes.map(node => {
    const response = combinedResponse([node], grid);
    let weight = 0, weightedRelevance = 0;
    for (let i = 0; i < grid.length; i++) {
      const band = bands.find(item => grid[i] >= item.lowHz && grid[i] < item.highHz);
      if (!band) continue;
      const influence = Math.abs(response[i]);
      weightedRelevance += influence * band.relevance; weight += influence;
    }
    return weight > 1e-9 ? weightedRelevance / weight : 1;
  });
  baselineNodes.forEach(node => node.disconnect());

  function candidate(amount: number) {
    const filters = profile.filters.map((filter, i) => ({ ...filter, gain: filter.gain * (1 - (1 - MIN_RETAINED_CORRECTION) * (1 - relevances[i]) * amount) }));
    const adapted = { ...profile, id: `${profile.id}:adaptive:${filters.map(filter => filter.gain.toPrecision(12)).join(',')}`, filters };
    const nodes = createFilters(context, adapted);
    const curve = combinedResponse(nodes, grid);
    let delta = 0;
    curve.forEach((value, i) => { delta = Math.max(delta, Math.abs(value - baseline[i])); });
    nodes.forEach(node => node.disconnect());
    return { profile: adapted, delta };
  }
  let applied = strength;
  let selected = candidate(applied);
  if (selected.delta > MAX_ADAPTIVE_DELTA_DB - 0.001) {
    let low = 0, high = strength;
    selected = { profile, delta: 0 };
    // Retain only candidates actually measured inside the bound; monotonicity
    // is not relied on for safety, only for finding a useful conservative setting.
    for (let iteration = 0; iteration < 14; iteration++) {
      const amount = (low + high) / 2, trial = candidate(amount);
      if (trial.delta <= MAX_ADAPTIVE_DELTA_DB - 0.001) { low = amount; selected = trial; }
      else high = amount;
    }
    applied = low;
  }
  const nodes = createFilters(context, selected.profile);
  const response = measureResponse(nodes, context.sampleRate);
  nodes.forEach(node => node.disconnect());
  return { status: 'ready', reason: null, requestedStrength: strength, appliedStrength: applied, maxDeltaDb: selected.delta,
    profile: selected.profile, response, bands,
    changes: profile.filters.map((filter, i) => ({ index: i + 1, frequency: filter.frequency, type: filter.type, q: filter.q, baseGainDb: filter.gain, adaptiveGainDb: selected.profile.filters[i].gain,
      relevance: relevances[i], retainedPercent: filter.gain !== 0 ? selected.profile.filters[i].gain / filter.gain * 100 : 100 })) };
}
