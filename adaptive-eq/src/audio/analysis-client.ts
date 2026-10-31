import type { TrackAnalysis } from './analysis-model.ts';
import type { AnalysisMessage } from './analysis.worker.ts';

export type AnalysisRunner = (buffer: AudioBuffer, onProgress: (progress: number) => void, signal: AbortSignal) => Promise<TrackAnalysis>;

export const analyzeAudioBuffer: AnalysisRunner = (buffer, onProgress, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new DOMException('Analysis cancelled.', 'AbortError')); return; }
  if (typeof Worker === 'undefined') { reject(new Error('Background audio analysis is unavailable in this browser.')); return; }
  let worker: Worker;
  try { worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' }); }
  catch { reject(new Error('The background analyzer could not start. Try loading the page again.')); return; }
  const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); worker.terminate(); };
  const fail = (error: Error) => { cleanup(); reject(error); };
  const abort = () => fail(new DOMException('Analysis cancelled.', 'AbortError'));
  const timeout = setTimeout(() => fail(new Error('Analysis took too long. Retry or choose a shorter track.')), 120000);
  signal.addEventListener('abort', abort, { once: true });
  worker.onmessage = (event: MessageEvent<AnalysisMessage>) => {
    const message = event.data;
    if (message.type === 'progress') onProgress(Math.max(0, Math.min(1, message.progress)));
    if (message.type === 'result') { cleanup(); resolve(message.result); }
    if (message.type === 'error') fail(new Error(message.error));
  };
  worker.onerror = event => { event.preventDefault(); fail(new Error('The background analyzer stopped. Retry analysis to start it again.')); };
  worker.onmessageerror = () => fail(new Error('The analysis result could not be read. Please retry.'));
  try {
    // Never transfer AudioBuffer-owned memory: retain PCM for playback and headroom checks.
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i).slice());
    worker.postMessage({ sampleRate: buffer.sampleRate, channels }, channels.map(channel => channel.buffer));
  } catch { fail(new Error('There was not enough memory to prepare this track for analysis. Try a shorter file.')); }
});
