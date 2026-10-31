import { ANALYSIS_BANDS } from '../src/audio/analysis-model.ts';
import type { TrackAnalysis } from '../src/audio/analysis-model.ts';

/** Explicit synthetic statistics for policy tests, not a recorded song. */
export function analysisFixture(dominantBand = 1): TrackAnalysis {
  return {
    version: 1, duration: 16, sampleRate: 48000, channels: 2,
    fftSize: 8192, hopSize: 4096, frequencyResolutionHz: 48000 / 8192,
    silenceGateDb: -60, activityPowerFraction: 0.01,
    totalFrames: 187, analyzedFrames: 187, hasContent: true,
    rmsDbfs: -14, samplePeakDbfs: -3, crestDb: 11, sections: [],
    bands: ANALYSIS_BANDS.map((band, i) => ({ ...band, available: true,
      energyPercent: i === dominantBand ? 93 : 1,
      activityPercent: i === dominantBand ? 100 : 0,
      medianSharePercent: i === dominantBand ? 93 : 1, variationPercentPoints: 0,
    })),
  };
}
