export const FFT_SIZE = 8192;
export const HOP_SIZE = FFT_SIZE / 2;
export const SILENCE_GATE_DB = -60;
export const ACTIVITY_POWER_FRACTION = 0.01;
export const ANALYSIS_BANDS = [
  { id: 'sub', name: 'Sub-bass', lowHz: 20, highHz: 60 },
  { id: 'bass', name: 'Bass', lowHz: 60, highHz: 150 },
  { id: 'low-mid', name: 'Low mids', lowHz: 150, highHz: 400 },
  { id: 'mid', name: 'Mids', lowHz: 400, highHz: 1000 },
  { id: 'upper-mid', name: 'Upper mids', lowHz: 1000, highHz: 2500 },
  { id: 'presence', name: 'Presence', lowHz: 2500, highHz: 5000 },
  { id: 'treble', name: 'Treble', lowHz: 5000, highHz: 10000 },
  { id: 'air', name: 'Air', lowHz: 10000, highHz: 20000 },
] as const;
export interface BandAnalysis {
  id: string; name: string; lowHz: number; highHz: number; available: boolean;
  energyPercent: number; activityPercent: number; medianSharePercent: number; variationPercentPoints: number;
}
export interface AnalysisSection { startSeconds: number; endSeconds: number; energyPercent: number[]; activeFraction: number }
export interface TrackAnalysis {
  version: 1; duration: number; sampleRate: number; channels: number;
  fftSize: number; hopSize: number; frequencyResolutionHz: number;
  silenceGateDb: number; activityPowerFraction: number;
  totalFrames: number; analyzedFrames: number; hasContent: boolean;
  rmsDbfs: number | null; samplePeakDbfs: number | null; crestDb: number | null;
  bands: BandAnalysis[]; sections: AnalysisSection[];
}
export interface AnalysisInput { sampleRate: number; channels: Float32Array[] }
export interface AnalysisState {
  status: 'idle' | 'running' | 'ready' | 'cancelled' | 'error';
  progress: number; result: TrackAnalysis | null; error: string | null;
}
export const emptyAnalysis = (): AnalysisState => ({ status: 'idle', progress: 0, result: null, error: null });
