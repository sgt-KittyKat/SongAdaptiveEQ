import { EqualizerChain, getProfile, responsePreamp, checkTrackPeaks, samplePeak, gainToDb, PEAK_CEILING_DB } from './equalizer.ts';
import type { EqResponse, PeakCheck, PlaybackMode } from './equalizer.ts';
import { createAdaptivePlan, emptyAdaptive } from './adaptive.ts';
import type { AdaptiveState, AdaptivePlan } from './adaptive.ts';
import { emptyAnalysis } from './analysis-model.ts';
import type { AnalysisState } from './analysis-model.ts';
import { analyzeAudioBuffer } from './analysis-client.ts';
import type { AnalysisRunner } from './analysis-client.ts';

export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 300;

export interface Track {
  name: string;
  title: string;
  format: string;
  bytes: number;
  duration: number;
  sampleRate: number;
  channels: number;
  waveform: number[];
}

export interface PlayerState {
  track: Track | null;
  loadingName: string | null;
  playing: boolean;
  starting: boolean;
  position: number;
  volume: number;
  error: string | null;
  profileId: string;
  correctionEnabled: boolean;
  mode: PlaybackMode;
  eqResponse: EqResponse | null;
  headroom: HeadroomState;
  analysis: AnalysisState;
  adaptive: AdaptiveState;
}

export interface HeadroomState {
  status: 'idle' | 'checking' | 'checked' | 'error';
  preampDb: number;
  originalPeakDb: number | null;
  correctedPeakDb: number | null;
  adaptivePeakDb?: number | null;
  error: string | null;
}

const emptyHeadroom = (): HeadroomState => ({ status: 'idle', preampDb: 0, originalPeakDb: null, correctedPeakDb: null, error: null });
export const correctionIsActive = (state: PlayerState) => state.profileId !== 'none' && state.correctionEnabled && state.headroom.status !== 'checking' && state.headroom.status !== 'error';
export const effectivePlaybackMode = (state: PlayerState): PlaybackMode => {
  if (!correctionIsActive(state)) return 'bypass';
  const plan = state.adaptive.plan;
  return state.mode === 'adaptive' && plan?.status === 'ready' && plan.maxDeltaDb > 1e-7 ? 'adaptive' : 'corrected';
};

const initialState = (): PlayerState => ({
  track: null, loadingName: null, playing: false, starting: false,
  position: 0, volume: 0.65, error: null,
  profileId: 'none', correctionEnabled: false, mode: 'bypass', eqResponse: null, headroom: emptyHeadroom(),
  analysis: emptyAnalysis(), adaptive: emptyAdaptive(),
});

/** Check compressed-file duration before allocating a potentially huge PCM buffer. */
function readFileDuration(file: File, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const media = new Audio();
    const url = URL.createObjectURL(file);
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      media.onloadedmetadata = null;
      media.onerror = null;
      media.removeAttribute('src');
      media.load();
      URL.revokeObjectURL(url);
    };
    const fail = (message: string) => { cleanup(); reject(new Error(message)); };
    const abort = () => fail('File loading canceled.');
    const timeout = setTimeout(() => fail('Reading this file took too long. Try another WAV or MP3.'), 15000);
    media.preload = 'metadata';
    media.onloadedmetadata = () => { const duration = media.duration; cleanup(); resolve(duration); };
    media.onerror = () => fail('We could not read this audio file. Try another WAV or MP3.');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    media.src = url;
    media.load();
  });
}

/** Downsample the real decoded waveform, retaining peaks in either channel. */
export function waveformPeaks(buffer: AudioBuffer, count = 180): number[] {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const peaks = Array.from({ length: count }, (_, bin) => {
    const start = Math.floor(bin * buffer.length / count);
    const end = Math.floor((bin + 1) * buffer.length / count);
    let peak = 0;
    for (const channel of channels) {
      for (let sample = start; sample < end; sample++) peak = Math.max(peak, Math.abs(channel[sample]));
    }
    return peak;
  });
  const largest = Math.max(...peaks, 0.001);
  return peaks.map((peak) => peak / largest);
}

/** One context and one active source; decoded PCM stays available for later analysis. */
export class AudioEngine {
  private state = initialState();
  private listeners = new Set<() => void>();
  private context: AudioContext | null = null;
  private input: GainNode | null = null;
  private master: GainNode | null = null;
  private equalizer: EqualizerChain | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private offset = 0;
  private startedAt = 0;
  private loadRevision = 0;
  private loadAbort: AbortController | null = null;
  private transportRevision = 0;
  private correctionRevision = 0;
  private headroomTask: Promise<void> = Promise.resolve();
  private verified: { buffer: AudioBuffer; profileId: string; result: PeakCheck } | null = null;
  private pendingCheck: { buffer: AudioBuffer; profileId: string; promise: Promise<PeakCheck> } | null = null;
  private rawPeak = 0;
  private lastAudibleVolume = 0.65;
  private contextFactory: () => AudioContext;
  private durationProbe: (file: File, signal: AbortSignal) => Promise<number | null>;
  private peakChecker: typeof checkTrackPeaks;
  private analysisRunner: AnalysisRunner;
  private analysisRevision = 0;
  private analysisAbort: AbortController | null = null;
  private adaptiveRevision = 0;
  private adaptiveQueued = false;
  private adaptiveBusy = false;
  private adaptiveChecks = new Map<string, PeakCheck>();

  constructor(
    contextFactory: () => AudioContext = () => new AudioContext(),
    durationProbe: (file: File, signal: AbortSignal) => Promise<number | null> = readFileDuration,
    peakChecker: typeof checkTrackPeaks = checkTrackPeaks,
    analysisRunner: AnalysisRunner = analyzeAudioBuffer,
  ) {
    this.contextFactory = contextFactory;
    this.durationProbe = durationProbe;
    this.peakChecker = peakChecker;
    this.analysisRunner = analysisRunner;
  }

  getSnapshot = (): PlayerState => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getAudioBuffer = () => this.buffer;

  private patch(update: Partial<PlayerState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener());
  }

  private ensureContext() {
    if (!this.context) {
      const context = this.contextFactory();
      const input = context.createGain();
      const master = context.createGain();
      master.gain.value = this.state.volume;
      this.equalizer = new EqualizerChain(context, input, master);
      master.connect(context.destination);
      this.context = context;
      this.input = input;
      this.master = master;
    }
    return this.context;
  }

  async loadFile(file: File): Promise<void> {
    const revision = ++this.loadRevision;
    this.invalidateAnalysis();
    this.invalidateAdaptive();
    this.adaptiveChecks.clear();
    ++this.correctionRevision;
    this.loadAbort?.abort();
    const abortController = new AbortController();
    this.loadAbort = abortController;
    ++this.transportRevision;
    this.stopSource();
    this.buffer = null;
    this.verified = null;
    this.pendingCheck = null;
    this.rawPeak = 0;
    this.offset = 0;
    this.patch({ track: null, playing: false, starting: false, position: 0, loadingName: file.name, error: null, analysis: emptyAnalysis(), adaptive: emptyAdaptive(this.state.adaptive.strength), headroom: { ...this.state.headroom, status: 'idle', originalPeakDb: null, correctedPeakDb: null, adaptivePeakDb: null, error: null } });

    try {
      if (!/\.(wav|mp3)$/i.test(file.name)) throw new Error('Choose a WAV or MP3 audio file.');
      if (file.size === 0) throw new Error('This file is empty. Choose another track.');
      if (file.size > MAX_FILE_BYTES) throw new Error('This file is too large. Choose a WAV or MP3 under 64 MB.');
      const context = this.ensureContext();
      const duration = await this.durationProbe(file, abortController.signal);
      if (revision !== this.loadRevision) return;
      if (duration !== null) {
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('This file has no readable audio duration. Try another WAV or MP3.');
        if (duration > MAX_DURATION_SECONDS + 0.05) throw new Error('Choose a track up to 5 minutes long for this prototype.');
      }
      const data = await file.arrayBuffer();
      if (revision !== this.loadRevision) return;
      let decoded: AudioBuffer;
      try {
        decoded = await context.decodeAudioData(data);
      } catch {
        throw new Error('We could not read this audio file. Try another WAV or MP3.');
      }
      if (revision !== this.loadRevision) return;
      if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new Error('This file has no playable audio.');
      if (decoded.duration > MAX_DURATION_SECONDS + 0.05) throw new Error('Choose a track up to 5 minutes long for this prototype.');
      if (decoded.numberOfChannels > 2) throw new Error('Choose a mono or stereo file. Surround audio is not supported yet.');
      const track: Track = {
        name: file.name,
        title: file.name.replace(/\.(wav|mp3)$/i, ''),
        format: /\.mp3$/i.test(file.name) ? 'MP3' : 'WAV',
        bytes: file.size,
        duration: decoded.duration,
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        waveform: waveformPeaks(decoded),
      };
      this.rawPeak = samplePeak(decoded);
      this.buffer = decoded;
      this.patch({ track, loadingName: null, position: 0 });
      this.analyzeTrack();
      await this.refreshCorrection();
    } catch (error) {
      if (revision !== this.loadRevision) return;
      this.patch({ loadingName: null, error: error instanceof Error ? error.message : 'Unable to load this file.' });
    } finally {
      if (revision === this.loadRevision) this.loadAbort = null;
    }
  }

  private invalidateAnalysis() {
    ++this.analysisRevision;
    this.analysisAbort?.abort();
    this.analysisAbort = null;
  }

  analyzeTrack = () => {
    const buffer = this.buffer;
    if (!buffer || this.state.analysis.status === 'running' || this.state.analysis.status === 'ready') return;
    this.invalidateAnalysis();
    const revision = this.analysisRevision;
    const controller = new AbortController();
    this.analysisAbort = controller;
    this.patch({ analysis: { status: 'running', progress: 0, result: null, error: null } });
    void Promise.resolve().then(() => this.analysisRunner(buffer, progress => {
      if (revision !== this.analysisRevision || buffer !== this.buffer || this.state.analysis.status !== 'running' || !Number.isFinite(progress)) return;
      this.patch({ analysis: { ...this.state.analysis, progress: Math.max(this.state.analysis.progress, Math.min(1, Math.max(0, progress))) } });
    }, controller.signal)).then(result => {
      if (revision !== this.analysisRevision || buffer !== this.buffer || controller.signal.aborted) return;
      this.analysisAbort = null;
      this.patch({ analysis: { status: 'ready', progress: 1, result, error: null } });
      this.requestAdaptiveUpdate();
    }).catch(error => {
      if (revision !== this.analysisRevision || buffer !== this.buffer || controller.signal.aborted) return;
      this.analysisAbort = null;
      this.patch({ analysis: { status: 'error', progress: 0, result: null, error: error instanceof Error ? error.message : 'Unable to analyze this track.' } });
      this.requestAdaptiveUpdate();
    });
  };

  cancelAnalysis = () => {
    if (this.state.analysis.status !== 'running') return;
    this.invalidateAnalysis();
    this.patch({ analysis: { ...this.state.analysis, status: 'cancelled', error: null } });
    this.requestAdaptiveUpdate();
  };

  private applyCorrection() {
    this.equalizer?.apply(effectivePlaybackMode(this.state), this.state.headroom.preampDb, this.state.playing);
  }

  private invalidateAdaptive() {
    ++this.adaptiveRevision;
    this.adaptiveQueued = false;
  }

  private requestAdaptiveUpdate() {
    ++this.adaptiveRevision;
    this.adaptiveQueued = true;
    if (this.adaptiveBusy) return;
    this.adaptiveBusy = true;
    // Serialize native renders and coalesce quick changes to the latest request.
    void (async () => {
      try {
        while (this.adaptiveQueued) {
          this.adaptiveQueued = false;
          await this.prepareAdaptive(this.adaptiveRevision);
        }
      } finally { this.adaptiveBusy = false; }
    })();
  }

  private async prepareAdaptive(revision: number) {
    const buffer = this.buffer, profile = getProfile(this.state.profileId), response = this.state.eqResponse;
    if (!buffer || !profile || !response || !this.context || !this.equalizer || this.state.headroom.status !== 'checked' || !this.verified) return;
    try {
      const plan = createAdaptivePlan(this.context, profile, response, this.state.analysis.status === 'ready' ? this.state.analysis.result : null, this.state.adaptive.strength);
      if (plan.profile === profile || plan.maxDeltaDb < 1e-7) {
        this.patch({ adaptive: { ...this.state.adaptive, status: plan.status, plan, error: null }, headroom: { ...this.state.headroom, adaptivePeakDb: this.state.headroom.correctedPeakDb } });
        this.applyCorrection();
        return;
      }
      this.patch({ adaptive: { ...this.state.adaptive, status: 'checking', error: null } });
      const measured = this.verified.result;
      const candidate = Math.min(this.state.headroom.preampDb, measured.preampDb, responsePreamp(plan.profile, plan.response));
      let checked = this.adaptiveChecks.get(plan.profile.id);
      if (!checked) {
        checked = await this.peakChecker(buffer, plan.profile, candidate);
        if (buffer === this.buffer && profile.id === this.state.profileId) this.adaptiveChecks.set(plan.profile.id, checked);
      }
      if (revision !== this.adaptiveRevision || buffer !== this.buffer || profile.id !== this.state.profileId) return;
      const preampDb = Math.min(candidate, checked.preampDb, this.state.headroom.preampDb);
      const installed = this.equalizer.installAdaptive(plan.profile);
      const verifiedPlan: AdaptivePlan = { ...plan, response: installed };
      this.patch({ adaptive: { ...this.state.adaptive, status: 'ready', plan: verifiedPlan, error: null }, headroom: {
        status: 'checked', preampDb, originalPeakDb: gainToDb(this.rawPeak) + preampDb,
        correctedPeakDb: measured.correctedPeakDb + preampDb - measured.preampDb,
        adaptivePeakDb: checked.correctedPeakDb + preampDb - checked.preampDb, error: null,
      } });
      this.applyCorrection();
    } catch (error) {
      if (revision !== this.adaptiveRevision || buffer !== this.buffer) return;
      this.patch({ adaptive: { ...this.state.adaptive, status: 'error', error: error instanceof Error ? error.message : 'Unable to verify adaptive correction.' } });
      this.applyCorrection();
    }
  }

  setAdaptiveStrength = (strength: number) => {
    if (!Number.isFinite(strength)) return;
    strength = Math.max(0, Math.min(1, strength));
    if (strength === this.state.adaptive.strength) return;
    this.patch({ adaptive: { ...this.state.adaptive, strength, error: null } });
    this.requestAdaptiveUpdate();
  };

  retryAdaptive = () => this.requestAdaptiveUpdate();

  private refreshCorrection(): Promise<void> {
    const task = this.prepareCorrection();
    this.headroomTask = task;
    return task;
  }

  private async prepareCorrection(): Promise<void> {
    const revision = ++this.correctionRevision;
    const profile = getProfile(this.state.profileId);
    const buffer = this.buffer;
    try {
      if (profile) this.ensureContext();
      const response = profile && this.equalizer ? this.equalizer.install(profile) : null;
      const rawGuard = Math.min(0, PEAK_CEILING_DB - gainToDb(this.rawPeak));
      const candidate = Math.min(rawGuard, profile && response ? responsePreamp(profile, response) : 0);
      if (!buffer || !profile) {
        this.patch({ eqResponse: response, headroom: { status: buffer ? 'checked' : 'idle', preampDb: candidate, originalPeakDb: buffer ? gainToDb(this.rawPeak) + candidate : null, correctedPeakDb: null, error: null } });
        this.applyCorrection();
        this.requestAdaptiveUpdate();
        return;
      }
      if (this.verified?.buffer === buffer && this.verified.profileId === profile.id) {
        this.patch({ eqResponse: response, headroom: { status: 'checked', ...this.verified.result, error: null } });
        this.applyCorrection();
        this.requestAdaptiveUpdate();
        return;
      }
      this.patch({ eqResponse: response, headroom: { status: 'checking', preampDb: candidate, originalPeakDb: gainToDb(this.rawPeak) + candidate, correctedPeakDb: null, error: null } });
      this.applyCorrection();
      if (!this.pendingCheck || this.pendingCheck.buffer !== buffer || this.pendingCheck.profileId !== profile.id) {
        const promise = this.peakChecker(buffer, profile, candidate).then(result => {
          if (this.buffer === buffer) this.verified = { buffer, profileId: profile.id, result };
          return result;
        }).finally(() => {
          if (this.pendingCheck?.promise === promise) this.pendingCheck = null;
        });
        this.pendingCheck = { buffer, profileId: profile.id, promise };
      }
      const result = await this.pendingCheck.promise;
      if (revision !== this.correctionRevision || buffer !== this.buffer) return;
      this.verified = { buffer, profileId: profile.id, result };
      this.patch({ headroom: { status: 'checked', ...result, error: null } });
      this.applyCorrection();
      this.requestAdaptiveUpdate();
    } catch (error) {
      if (revision !== this.correctionRevision) return;
      const rawGuard = Math.min(0, PEAK_CEILING_DB - gainToDb(this.rawPeak));
      this.patch({ correctionEnabled: false, eqResponse: null, headroom: { status: 'error', preampDb: rawGuard, originalPeakDb: buffer ? gainToDb(this.rawPeak) + rawGuard : null, correctedPeakDb: null, error: error instanceof Error ? error.message : 'Unable to verify this correction.' } });
      this.applyCorrection();
    }
  }

  selectProfile = (id: string) => {
    if (id !== 'none' && !getProfile(id)) return;
    if (id === this.state.profileId) return;
    this.invalidateAdaptive();
    this.adaptiveChecks.clear();
    this.patch({ profileId: id, correctionEnabled: id !== 'none', mode: id === 'none' ? 'bypass' : 'corrected', adaptive: emptyAdaptive(this.state.adaptive.strength) });
    void this.refreshCorrection();
  };

  setCorrectionEnabled = (enabled: boolean) => {
    this.setPlaybackMode(enabled ? 'corrected' : 'bypass');
  };

  setPlaybackMode = (mode: PlaybackMode) => {
    if (!['bypass', 'corrected', 'adaptive'].includes(mode)) return;
    if (mode !== 'bypass' && !getProfile(this.state.profileId)) return;
    this.patch({ mode, correctionEnabled: mode !== 'bypass' });
    if (mode !== 'bypass' && this.state.headroom.status === 'error') void this.refreshCorrection();
    else this.applyCorrection();
    if (mode === 'adaptive' && (!this.state.adaptive.plan || this.state.adaptive.status === 'error') && this.state.adaptive.status !== 'checking') this.requestAdaptiveUpdate();
  };

  private currentPosition() {
    if (!this.state.playing || !this.context) return this.offset;
    return Math.min(this.offset + this.context.currentTime - this.startedAt, this.buffer?.duration ?? 0);
  }

  private stopSource() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.source) {
      const oldSource = this.source;
      this.source = null;
      oldSource.onended = null;
      oldSource.stop();
      oldSource.disconnect();
    }
  }

  private startAt(position: number) {
    if (!this.context || !this.buffer || !this.input) return;
    const context = this.context;
    const source = context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.input);
    source.onended = () => {
      if (this.source !== source) return;
      source.disconnect();
      this.source = null;
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      this.offset = this.buffer?.duration ?? 0;
      this.patch({ playing: false, position: this.offset });
    };
    source.start(0, position);
    this.source = source;
    this.offset = position;
    this.startedAt = context.currentTime;
    this.patch({ playing: true, starting: false, position });
    this.timer = setInterval(() => this.patch({ position: this.currentPosition() }), 100);
  }

  async play(): Promise<void> {
    if (!this.buffer || this.state.playing || this.state.starting) return;
    const revision = ++this.transportRevision;
    this.patch({ starting: true, error: null });
    try {
      const context = this.ensureContext();
      await context.resume();
      while (this.state.correctionEnabled && this.state.headroom.status === 'checking') {
        await this.headroomTask;
        if (revision !== this.transportRevision) return;
      }
      if (revision !== this.transportRevision || !this.buffer) return;
      if (context.state !== 'running') throw new Error('Audio is paused by the browser. Click Play to try again.');
      this.startAt(this.offset >= this.buffer.duration ? 0 : this.offset);
    } catch (error) {
      if (revision !== this.transportRevision) return;
      this.patch({ starting: false, error: error instanceof Error ? error.message : 'Unable to start playback.' });
    }
  }

  pause = () => {
    ++this.transportRevision;
    this.offset = this.currentPosition();
    this.stopSource();
    this.patch({ playing: false, starting: false, position: this.offset });
  };

  togglePlayback = () => {
    if (this.state.playing || this.state.starting) this.pause();
    else void this.play();
  };

  seek = (position: number) => {
    if (!this.buffer || !Number.isFinite(position)) return;
    ++this.transportRevision;
    const wasPlaying = this.state.playing;
    const wasStarting = this.state.starting;
    this.stopSource();
    this.offset = Math.max(0, Math.min(position, this.buffer.duration));
    this.patch({ position: this.offset, playing: false, starting: false });
    if (wasPlaying && this.offset < this.buffer.duration) this.startAt(this.offset);
    else if (wasStarting && this.offset < this.buffer.duration) void this.play();
  };

  skip = (seconds: number) => this.seek(this.currentPosition() + seconds);

  setVolume = (volume: number) => {
    if (!Number.isFinite(volume)) return;
    volume = Math.max(0, Math.min(1, volume));
    if (volume > 0) this.lastAudibleVolume = volume;
    if (this.master && this.context) this.master.gain.setTargetAtTime(volume, this.context.currentTime, 0.015);
    this.patch({ volume });
  };

  toggleMute = () => this.setVolume(this.state.volume > 0 ? 0 : this.lastAudibleVolume);

  clearError = () => this.patch({ error: null });

  clear = () => {
    this.invalidateAnalysis();
    this.invalidateAdaptive();
    this.adaptiveChecks.clear();
    ++this.loadRevision;
    this.loadAbort?.abort();
    this.loadAbort = null;
    ++this.transportRevision;
    ++this.correctionRevision;
    this.stopSource();
    this.buffer = null;
    this.rawPeak = 0;
    this.verified = null;
    this.pendingCheck = null;
    this.offset = 0;
    this.patch({ track: null, loadingName: null, position: 0, playing: false, starting: false, error: null, analysis: emptyAnalysis(), adaptive: emptyAdaptive(this.state.adaptive.strength) });
    void this.refreshCorrection();
  };

  dispose = () => {
    this.clear();
    this.equalizer?.dispose();
    this.input?.disconnect();
    this.master?.disconnect();
    void this.context?.close();
    this.input = null;
    this.master = null;
    this.context = null;
    this.equalizer = null;
  };
}

export const audioEngine = new AudioEngine();
