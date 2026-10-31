import Meyda from 'meyda';
import { FFT_SIZE, HOP_SIZE, SILENCE_GATE_DB, ACTIVITY_POWER_FRACTION, ANALYSIS_BANDS } from './analysis-model.ts';
import type { AnalysisInput, TrackAnalysis } from './analysis-model.ts';

/** Pure analysis of original PCM. Each call runs in its own browser worker. */
export function analyzeSamples(input: AnalysisInput, onProgress: (fraction: number) => void = () => {}): TrackAnalysis {
  const { channels, sampleRate } = input;
  if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 384000) throw new Error('The sample rate is not supported for analysis.');
  if (!channels.length || channels.length > 2 || !channels[0].length || channels.some(channel => channel.length !== channels[0].length)) throw new Error('Analysis requires equally sized mono or stereo channels.');
  const length = channels[0].length;
  const duration = length / sampleRate;
  const totalFrames = Math.ceil(length / HOP_SIZE) + 1;
  const sectionCount = Math.min(64, Math.max(1, Math.ceil(duration)));
  const sectionPowers = Array.from({ length: sectionCount }, () => new Float64Array(ANALYSIS_BANDS.length));
  const sectionFrames = new Uint32Array(sectionCount), sectionActive = new Uint32Array(sectionCount);
  const means = new Float64Array(channels.length);
  let peak = 0, sumSquares = 0;
  onProgress(0);
  for (let channel = 0; channel < channels.length; channel++) {
    const samples = channels[channel];
    for (let i = 0; i < length; i++) {
      const value = samples[i];
      if (!Number.isFinite(value)) throw new Error('The recording contains invalid sample values.');
      peak = Math.max(peak, Math.abs(value)); sumSquares += value * value; means[channel] += value;
      if (i % 262144 === 0) onProgress(0.1 * (channel * length + i) / (length * channels.length));
    }
    means[channel] /= length;
  }
  const rms = Math.sqrt(sumSquares / (length * channels.length));
  const db = (value: number) => value > 0 ? 20 * Math.log10(value) : null;
  const bandRanges = ANALYSIS_BANDS.map(band => ({ ...band, highHz: Math.max(band.lowHz, Math.min(band.highHz, sampleRate / 2)), available: band.lowHz < sampleRate / 2 }));
  const result: TrackAnalysis = {
    version: 1, duration, sampleRate, channels: channels.length,
    fftSize: FFT_SIZE, hopSize: HOP_SIZE, frequencyResolutionHz: sampleRate / FFT_SIZE,
    silenceGateDb: SILENCE_GATE_DB, activityPowerFraction: ACTIVITY_POWER_FRACTION,
    totalFrames, analyzedFrames: 0, hasContent: false,
    rmsDbfs: db(rms), samplePeakDbfs: db(peak), crestDb: rms > 0 ? 20 * Math.log10(peak / rms) : null,
    bands: bandRanges.map(band => ({ ...band, energyPercent: 0, activityPercent: 0, medianSharePercent: 0, variationPercentPoints: 0 })),
    sections: Array.from({ length: sectionCount }, (_, i) => ({ startSeconds: duration * i / sectionCount, endSeconds: duration * (i + 1) / sectionCount, energyPercent: Array<number>(8).fill(0), activeFraction: 0 })),
  };
  if (peak === 0) { onProgress(1); return result; }

  // A separate level pass establishes a relative gate before spectral extraction.
  // Subtract only the whole-track channel mean; per-frame demeaning would alter bass.
  const frameLevels = new Float64Array(totalFrames);
  let maxLevel = 0;
  for (let frame = 0; frame < totalFrames; frame++) {
    const start = frame * HOP_SIZE - HOP_SIZE;
    const first = Math.max(0, start), last = Math.min(length, start + FFT_SIZE);
    let power = 0;
    for (let channel = 0; channel < channels.length; channel++) {
      for (let i = first; i < last; i++) { const value = (channels[channel][i] - means[channel]) / peak; power += value * value; }
    }
    frameLevels[frame] = power / (Math.max(1, last - first) * channels.length);
    maxLevel = Math.max(maxLevel, frameLevels[frame]);
    if (frame % 32 === 0) onProgress(0.1 + 0.1 * frame / totalFrames);
  }
  if (maxLevel === 0) { onProgress(1); return result; }
  const gate = maxLevel * 10 ** (SILENCE_GATE_DB / 10);

  // Fractional overlap avoids assigning a whole boundary FFT bin to both bands.
  const binWidth = sampleRate / FFT_SIZE;
  const binWeights = bandRanges.map(band => {
    const weights: { bin: number; weight: number }[] = [];
    if (!band.available) return weights;
    for (let bin = 1; bin < FFT_SIZE / 2; bin++) {
      const overlap = Math.min(band.highHz, (bin + 0.5) * binWidth) - Math.max(band.lowHz, (bin - 0.5) * binWidth);
      if (overlap > 0) weights.push({ bin, weight: overlap / binWidth });
    }
    return weights;
  });
  const bandPowers = new Float64Array(8), activities = new Uint32Array(8);
  const shares = Array.from({ length: 8 }, () => [] as number[]);
  const frameBuffer = new Float32Array(FFT_SIZE);
  Meyda.bufferSize = FFT_SIZE; Meyda.sampleRate = sampleRate; Meyda.windowingFunction = 'hanning';
  onProgress(0.2);
  for (let frame = 0; frame < totalFrames; frame++) {
    const start = frame * HOP_SIZE - HOP_SIZE;
    const center = Math.min(length - 1, Math.max(0, frame * HOP_SIZE));
    const section = Math.min(sectionCount - 1, Math.floor(center / length * sectionCount));
    sectionFrames[section]++;
    if (frameLevels[frame] > 0 && frameLevels[frame] >= gate) {
      const powers = new Float64Array(8);
      for (let channel = 0; channel < channels.length; channel++) {
        frameBuffer.fill(0);
        const first = Math.max(0, start), last = Math.min(length, start + FFT_SIZE);
        for (let i = first; i < last; i++) frameBuffer[i - start] = (channels[channel][i] - means[channel]) / peak;
        const spectrum = Meyda.extract(['powerSpectrum'], frameBuffer)?.powerSpectrum;
        if (!spectrum) throw new Error('The frequency analysis did not produce a spectrum.');
        for (let band = 0; band < 8; band++) {
          for (const { bin, weight } of binWeights[band]) powers[band] += spectrum[bin] * weight / channels.length;
        }
      }
      const total = powers.reduce((sum, value) => sum + value, 0);
      if (total > 0) {
        result.analyzedFrames++; sectionActive[section]++;
        for (let band = 0; band < 8; band++) {
          const share = powers[band] / total;
          bandPowers[band] += powers[band]; sectionPowers[section][band] += powers[band]; shares[band].push(share);
          if (share >= ACTIVITY_POWER_FRACTION) activities[band]++;
        }
      }
    }
    if (frame % 16 === 0) onProgress(0.2 + 0.79 * (frame + 1) / totalFrames);
  }
  const totalPower = bandPowers.reduce((sum, value) => sum + value, 0);
  result.hasContent = totalPower > 0;
  result.bands.forEach((band, i) => {
    const values = shares[i].sort((a, b) => a - b);
    if (!values.length || totalPower === 0) return;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    band.energyPercent = bandPowers[i] / totalPower * 100;
    band.activityPercent = activities[i] / result.analyzedFrames * 100;
    band.medianSharePercent = median * 100;
    band.variationPercentPoints = Math.sqrt(variance) * 100;
  });
  result.sections.forEach((section, i) => {
    const total = sectionPowers[i].reduce((sum, value) => sum + value, 0);
    section.energyPercent = Array.from(sectionPowers[i], value => total > 0 ? value / total * 100 : 0);
    section.activeFraction = sectionFrames[i] > 0 ? sectionActive[i] / sectionFrames[i] : 0;
  });
  onProgress(1);
  return result;
}
