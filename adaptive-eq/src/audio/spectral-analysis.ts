import type { SpectralAnalysis, SpectralBand } from './analysis-model.ts';

export const DETAIL_BANDS = Array.from({ length: 30 }, (_, i) => ({ lowHz: 20 * 2 ** (i / 3), highHz: Math.min(20000, 20 * 2 ** ((i + 1) / 3)) }));
export function quantile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  const position = fraction * (sorted.length - 1), first = Math.floor(position);
  return sorted[first] + (sorted[Math.min(first + 1, sorted.length - 1)] - sorted[first]) * (position - first);
}
export const median = (values: number[]) => quantile([...values].sort((a, b) => a - b), 0.5);
export function smoothOctaves(frequencies: number[], values: number[], weights: number[], sigma = 0.45): number[] {
  return frequencies.map(frequency => {
    let total = 0, weight = 0;
    frequencies.forEach((other, i) => {
      const w = Math.exp(-0.5 * (Math.log2(other / frequency) / sigma) ** 2) * weights[i];
      total += w * values[i]; weight += w;
    });
    return weight > 0 ? total / weight : 0;
  });
}
export function robustTilt(bands: SpectralBand[]): number | null {
  const supported = bands.filter(band => band.frequency >= 100 && band.frequency <= 10000 && band.reliability >= 0.25);
  const slopes: number[] = [];
  supported.forEach((a, i) => supported.slice(i + 1).forEach(b => {
    const octaves = Math.log2(b.frequency / a.frequency);
    if (octaves >= 1) slopes.push((b.densityDb - a.densityDb) / octaves);
  }));
  return slopes.length ? median(slopes) : null;
}

/** Equal-time relative powers prevent louder sections from getting extra votes.
 * A 10% two-sided trim plus the median rejects brief transients without discarding sections. */
export function summarizeSpectrum(ranges: { lowHz: number; highHz: number; available: boolean }[], shares: number[][], contrasts: number[][], binWidth: number): SpectralAnalysis {
  const bands: SpectralBand[] = ranges.map((range, i) => {
    const sorted = [...shares[i]].sort((a, b) => a - b), n = sorted.length, trim = Math.floor(n * 0.1);
    const middle = sorted.slice(trim, Math.max(trim + 1, n - trim));
    const power = n ? 0.65 * middle.reduce((sum, v) => sum + v, 0) / middle.length + 0.35 * quantile(sorted, 0.5) : 0;
    const octaves = range.available ? Math.log2(range.highHz / range.lowHz) : 1;
    const activityFloor = Math.max(1e-6, quantile(sorted, 0.75) * 0.01);
    const activity = n ? sorted.filter(value => value > activityFloor).length / n : 0;
    const spread = n ? 10 * Math.log10(Math.max(quantile(sorted, 0.8), 1e-10) / Math.max(quantile(sorted, 0.2), 1e-10)) : 0;
    const resolution = Math.min(1, (range.highHz - range.lowHz) / (2 * binWidth));
    return { ...range, frequency: Math.sqrt(range.lowHz * range.highHz), robustPower: power,
      densityDb: 10 * Math.log10(Math.max(power / octaves, 1e-10)), activityPercent: activity * 100,
      spreadDb: Math.max(0, spread), contrastDb: median(contrasts[i]),
      reliability: range.available ? activity * (0.4 + 0.6 / (1 + (spread / 12) ** 2)) * resolution : 0, localDeviationDb: 0 };
  });
  const total = bands.reduce((sum, band) => sum + band.robustPower, 0);
  if (total > 0) bands.forEach(band => { band.robustPower /= total; band.densityDb = 10 * Math.log10(Math.max(band.robustPower / Math.max(0.001, Math.log2(band.highHz / band.lowHz)), 1e-10)); });
  const broad = smoothOctaves(bands.map(b => b.frequency), bands.map(b => b.densityDb), bands.map(b => b.reliability), 0.7);
  bands.forEach((band, i) => { band.localDeviationDb = band.densityDb - broad[i]; });
  return { bands, tiltDbPerOctave: robustTilt(bands), contrastDb: median(bands.filter(b => b.reliability >= 0.25).map(b => b.contrastDb)), aggregation: 'frame-normalized-trimmed-power', trimFraction: 0.1 };
}
