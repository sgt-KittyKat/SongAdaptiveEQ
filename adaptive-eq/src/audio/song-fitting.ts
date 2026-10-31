import { combinedResponse, createFilters, responseGrid } from './equalizer.ts';
import type { EqFilter, FilterContext, HeadphoneProfile } from './equalizer.ts';

/** Fit broad native filters to a weighted log-frequency goal. Fitting the whole
 * cascade avoids treating overlapping filters as independent gain controls. */
export function fitSongFilters(context: FilterContext, profile: HeadphoneProfile, frequencies: number[], desired: number[], weights: number[], limit = 5) {
  const grid = Float32Array.from(frequencies), filters: EqFilter[] = [];
  const curveFor = (filter: EqFilter, at = grid) => {
    const nodes = createFilters(context, { ...profile, filters: [filter] });
    const curve = combinedResponse(nodes, at); nodes.forEach(node => node.disconnect()); return Array.from(curve);
  };
  let curves: number[][] = [], sum = frequencies.map(() => 0);
  const fit = () => {
    for (let sweep = 0; sweep < 7; sweep++) for (let j = 0; j < filters.length; j++) {
      const derivative = curveFor({ ...filters[j], gain: filters[j].gain + 0.15 }).map((v, i) => (v - curves[j][i]) / 0.15);
      let numerator = -0.035 * filters[j].gain, denominator = 0.035;
      frequencies.forEach((_, i) => { numerator += weights[i] * derivative[i] * (desired[i] - sum[i]); denominator += weights[i] * derivative[i] ** 2; });
      const step = Math.max(-1.5, Math.min(1.5, numerator / denominator));
      filters[j].gain = Math.max(-limit, Math.min(limit, filters[j].gain + step * 0.9));
      const next = curveFor(filters[j]); sum = sum.map((v, i) => v - curves[j][i] + next[i]); curves[j] = next;
    }
  };
  const add = (filter: EqFilter) => { filters.push(filter); curves.push(curveFor(filter)); fit(); };
  // Shelves handle broad tilt. Peaks are placed from the remaining supported residual.
  if (frequencies.some((f, i) => f < 180 && weights[i] > 0.1)) add({ type: 'lowshelf', frequency: 110, q: 0.7, gain: 0 });
  if (frequencies.some((f, i) => f > 5000 && weights[i] > 0.1) && context.sampleRate / 2 > 7000) add({ type: 'highshelf', frequency: 7000, q: 0.7, gain: 0 });
  for (let iteration = 0; iteration < 6; iteration++) {
    const candidates = frequencies.map((frequency, i) => ({ frequency, i, score: Math.abs(desired[i] - sum[i]) * Math.sqrt(weights[i]) }))
      .filter(item => item.frequency >= 55 && item.frequency <= Math.min(11000, context.sampleRate * 0.4) && !filters.some(filter => filter.type === 'peaking' && Math.abs(Math.log2(filter.frequency / item.frequency)) < 0.65))
      .sort((a, b) => b.score - a.score);
    const selected = candidates[0];
    if (!selected || selected.score < 0.55) break;
    const residual = desired.map((v, i) => v - sum[i]), sign = Math.sign(residual[selected.i]);
    let first = selected.i, last = selected.i;
    while (first > 0 && sign * residual[first - 1] > Math.abs(residual[selected.i]) * 0.45) first--;
    while (last < residual.length - 1 && sign * residual[last + 1] > Math.abs(residual[selected.i]) * 0.45) last++;
    const width = Math.max(0.8, Math.log2(frequencies[last] / frequencies[first]));
    const q = Math.max(0.55, Math.min(1.35, 1 / (2 ** (width / 2) - 2 ** (-width / 2))));
    add({ type: 'peaking', frequency: selected.frequency, q, gain: 0 });
  }
  const dense = responseGrid(context.sampleRate);
  const denseCurve = (amount: number) => {
    const nodes = createFilters(context, { ...profile, filters: filters.map(f => ({ ...f, gain: f.gain * amount })) });
    const response = combinedResponse(nodes, dense); nodes.forEach(node => node.disconnect());
    return Math.max(0, ...response.map(Math.abs));
  };
  let amount = 1, peak = denseCurve(amount);
  if (peak > limit - 0.001) {
    let low = 0, high = 1;
    for (let i = 0; i < 14; i++) { const mid = (low + high) / 2; if (denseCurve(mid) <= limit - 0.001) low = mid; else high = mid; }
    amount = low; peak = denseCurve(amount);
  }
  const fitted = filters.map(filter => ({ ...filter, gain: filter.gain * amount })).filter(filter => Math.abs(filter.gain) > 1e-6);
  const nodes = createFilters(context, { ...profile, filters: fitted });
  const actual = Array.from(combinedResponse(nodes, grid)); nodes.forEach(node => node.disconnect());
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const error = Math.sqrt(actual.reduce((v, gain, i) => v + weights[i] * (gain - desired[i]) ** 2, 0) / Math.max(totalWeight, 1e-9));
  // Recheck after pruning negligible filters as their removal can change cancellation.
  const verified = createFilters(context, { ...profile, filters: fitted });
  const finalPeak = Math.max(0, ...combinedResponse(verified, dense).map(Math.abs)); verified.forEach(node => node.disconnect());
  if (finalPeak > limit) throw new Error('The fitted song response exceeded its verified bound.');
  return { filters: fitted, peakDb: finalPeak, amount, fitErrorDb: error, actual };
}
