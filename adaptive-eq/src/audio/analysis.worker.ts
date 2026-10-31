import { analyzeSamples } from './track-analysis.ts';
import type { AnalysisInput, TrackAnalysis } from './analysis-model.ts';

export type AnalysisMessage = { type: 'progress'; progress: number } | { type: 'result'; result: TrackAnalysis } | { type: 'error'; error: string };
const workerScope = self as unknown as { onmessage: ((event: MessageEvent<AnalysisInput>) => void) | null; postMessage(message: AnalysisMessage): void };
workerScope.onmessage = (event) => {
  try {
    let previous = -1;
    const result = analyzeSamples(event.data, progress => {
      if (progress === 1 || progress - previous >= 0.01) { previous = progress; workerScope.postMessage({ type: 'progress', progress }); }
    });
    workerScope.postMessage({ type: 'result', result });
  } catch (error) {
    workerScope.postMessage({ type: 'error', error: error instanceof Error ? error.message : 'Unable to analyze this track.' });
  }
};
