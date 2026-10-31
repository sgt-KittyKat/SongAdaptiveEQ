import arctisData from '../data/arctis-7-plus.json' with { type: 'json' };

export interface EqFilter { type: 'peaking' | 'lowshelf' | 'highshelf'; frequency: number; gain: number; q: number }
export interface HeadphoneProfile {
  id: string; name: string; measurementSource: string; measurementRig: string; target: string;
  preampDb: number; filters: EqFilter[];
  provenance: { repository: string; commit: string; sourceUrl: string; sha256: string; presetUrl: string; licenseUrl: string; importedOn: string };
}
export const HEADPHONE_PROFILES: HeadphoneProfile[] = [arctisData as HeadphoneProfile];
export const getProfile = (id: string): HeadphoneProfile | null => HEADPHONE_PROFILES.find(p => p.id === id) ?? null;
export const dbToGain = (db: number) => 10 ** (db / 20);
export const gainToDb = (gain: number) => gain > 0 ? 20 * Math.log10(gain) : -Infinity;
export const PEAK_CEILING_DB = -1;
export const FADE_SECONDS = 0.04;
export type PlaybackMode = 'bypass' | 'corrected' | 'adaptive';

/** RBJ shelf coefficients with the preset's Q; native Web Audio shelves ignore Q. */
export function shelfCoefficients(filter: EqFilter, sampleRate: number) {
  const A = 10 ** (filter.gain / 40);
  const w = 2 * Math.PI * filter.frequency / sampleRate;
  const c = Math.cos(w);
  const alpha = Math.sin(w) / (2 * filter.q);
  const beta = 2 * Math.sqrt(A) * alpha;
  let b: number[], a: number[];
  if (filter.type === 'lowshelf') {
    b = [A * ((A + 1) - (A - 1) * c + beta), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - beta)];
    a = [(A + 1) + (A - 1) * c + beta, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - beta];
  } else if (filter.type === 'highshelf') {
    b = [A * ((A + 1) + (A - 1) * c + beta), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - beta)];
    a = [(A + 1) - (A - 1) * c + beta, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - beta];
  } else throw new Error('Expected a shelf filter.');
  const a0 = a[0];
  return { feedforward: b.map(v => v / a0), feedback: a.map(v => v / a0) };
}

export type ResponseFilter = BiquadFilterNode | IIRFilterNode;
export type FilterContext = Pick<BaseAudioContext, 'sampleRate' | 'createBiquadFilter' | 'createIIRFilter'>;
export function createFilters(context: FilterContext, profile: HeadphoneProfile): ResponseFilter[] {
  if (profile.filters.some(f => f.frequency >= context.sampleRate / 2)) throw new Error('This profile needs a playback sample rate above 20 kHz.');
  return profile.filters.map(filter => {
    if (filter.type !== 'peaking') {
      const coefficients = shelfCoefficients(filter, context.sampleRate);
      return context.createIIRFilter(coefficients.feedforward, coefficients.feedback);
    }
    const node = context.createBiquadFilter();
    node.type = 'peaking'; node.frequency.value = filter.frequency; node.Q.value = filter.q; node.gain.value = filter.gain;
    return node;
  });
}

export interface EqResponse { frequencies: number[]; correctionDb: number[]; peakBoostDb: number; sampleRate: number }
export function responseGrid(sampleRate: number): Float32Array<ArrayBuffer> {
  const end = sampleRate / 2;
  return Float32Array.from([0, ...Array.from({ length: 4096 }, (_, i) => Math.exp(Math.log(end * 0.999) * i / 4095)), end]);
}

export function combinedResponse(filters: ResponseFilter[], grid: Float32Array<ArrayBuffer>): Float64Array {
  const total = new Float64Array(grid.length);
  const magnitudes = new Float32Array(grid.length), phases = new Float32Array(grid.length);
  for (const filter of filters) {
    filter.getFrequencyResponse(grid, magnitudes, phases);
    for (let i = 0; i < grid.length; i++) {
      if (!Number.isFinite(magnitudes[i]) || magnitudes[i] <= 0) throw new Error('The EQ response could not be calculated.');
      total[i] += gainToDb(magnitudes[i]);
    }
  }
  return total;
}

export function measureResponse(filters: ResponseFilter[], sampleRate: number): EqResponse {
  // Include DC and Nyquist in the headroom bound, even though the plot shows 20 Hz-20 kHz.
  const end = sampleRate / 2;
  const grid = responseGrid(sampleRate);
  const total = combinedResponse(filters, grid);
  const displayIndexes = Array.from(grid.keys()).filter(i => grid[i] >= 20 && grid[i] <= Math.min(20000, end * 0.99)).filter((_, i) => i % 6 === 0);
  return { frequencies: displayIndexes.map(i => grid[i]), correctionDb: displayIndexes.map(i => total[i]), peakBoostDb: Math.max(0, ...total), sampleRate };
}

export function responsePreamp(profile: HeadphoneProfile, response: EqResponse): number {
  return Math.min(0, profile.preampDb, -response.peakBoostDb + PEAK_CEILING_DB);
}

export function samplePeak(buffer: AudioBuffer): number {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) {
      if (!Number.isFinite(data[i])) throw new Error('This audio file contains invalid sample values.');
      peak = Math.max(peak, Math.abs(data[i]));
    }
  }
  return peak;
}

export interface PeakCheck { preampDb: number; originalPeakDb: number; correctedPeakDb: number }
export function finishPeakCheck(candidatePreampDb: number, originalPeak: number, renderedPeak: number): PeakCheck {
  const additional = Math.min(0, PEAK_CEILING_DB - gainToDb(Math.max(originalPeak * dbToGain(candidatePreampDb), renderedPeak)));
  return { preampDb: candidatePreampDb + additional, originalPeakDb: gainToDb(originalPeak) + candidatePreampDb + additional, correctedPeakDb: gainToDb(renderedPeak) + additional };
}

/** Native offline rendering uses exactly the same filter construction as playback. */
export async function checkTrackPeaks(buffer: AudioBuffer, profile: HeadphoneProfile, candidatePreampDb: number): Promise<PeakCheck> {
  const offline = new OfflineAudioContext(buffer.numberOfChannels, buffer.length + Math.ceil(buffer.sampleRate * 0.5), buffer.sampleRate);
  const source = offline.createBufferSource(); source.buffer = buffer;
  const preamp = offline.createGain(); preamp.gain.value = dbToGain(candidatePreampDb);
  source.connect(preamp);
  const filters = createFilters(offline, profile);
  let previous: AudioNode = preamp;
  for (const filter of filters) { previous.connect(filter); previous = filter; }
  previous.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const result = finishPeakCheck(candidatePreampDb, samplePeak(buffer), samplePeak(rendered));
  source.disconnect(); preamp.disconnect(); filters.forEach(node => node.disconnect());
  return result;
}

function hold(param: AudioParam, now: number) {
  if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
  else { const value = param.value; param.cancelScheduledValues(now); param.setValueAtTime(value, now); }
}

/** Warm wet path plus a dry path. Linear fades keep their mix weights summing to one. */
export class EqualizerChain {
  private context: AudioContext;
  private input: GainNode;
  private preamp: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  private output: GainNode;
  private adaptive: GainNode;
  private adaptiveFilters: ResponseFilter[] = [];
  private adaptiveId: string | null = null;
  private retiring: { gain: GainNode; filters: ResponseFilter[]; timer: ReturnType<typeof setTimeout> | null }[] = [];
  private filters: ResponseFilter[] = [];
  private installedId: string | null = null;
  private trimDb = 0;

  constructor(context: AudioContext, input: GainNode, output: GainNode) {
    this.context = context; this.input = input; this.output = output;
    this.preamp = context.createGain(); this.dry = context.createGain(); this.wet = context.createGain();
    this.adaptive = context.createGain(); this.adaptive.gain.value = 0;
    this.dry.gain.value = 1; this.wet.gain.value = 0;
    input.connect(this.preamp); this.preamp.connect(this.dry); this.dry.connect(output); this.wet.connect(output); this.adaptive.connect(output);
  }

  install(profile: HeadphoneProfile): EqResponse {
    if (profile.id !== this.installedId) {
      const filters = createFilters(this.context, profile);
      // The bundled app has one supported profile; selecting None retains its warm, muted path.
      if (this.filters.length) { this.preamp.disconnect(this.filters[0]); this.filters.forEach(node => node.disconnect()); }
      let previous: AudioNode = this.preamp;
      for (const filter of filters) { previous.connect(filter); previous = filter; }
      previous.connect(this.wet); this.filters = filters; this.installedId = profile.id;
    }
    return measureResponse(this.filters, this.context.sampleRate);
  }

  installAdaptive(profile: HeadphoneProfile): EqResponse {
    if (profile.id !== this.adaptiveId) {
      const nodes = createFilters(this.context, profile);
      if (this.adaptiveFilters.length) {
        this.retiring.push({ gain: this.adaptive, filters: this.adaptiveFilters, timer: null });
        this.adaptive = this.context.createGain(); this.adaptive.gain.value = 0; this.adaptive.connect(this.output);
      }
      let previous: AudioNode = this.preamp;
      for (const node of nodes) { previous.connect(node); previous = node; }
      previous.connect(this.adaptive);
      this.adaptiveFilters = nodes; this.adaptiveId = profile.id;
    }
    return measureResponse(this.adaptiveFilters, this.context.sampleRate);
  }

  private retire(branch: typeof this.retiring[number]) {
    if (!this.retiring.includes(branch)) return;
    if (branch.timer !== null) clearTimeout(branch.timer);
    this.preamp.disconnect(branch.filters[0]); branch.filters.forEach(node => node.disconnect()); branch.gain.disconnect();
    this.retiring = this.retiring.filter(item => item !== branch);
  }

  apply(mode: boolean | PlaybackMode, preampDb: number, playing: boolean) {
    if (typeof mode === 'boolean') mode = mode ? 'corrected' : 'bypass';
    if (mode === 'adaptive' && !this.adaptiveFilters.length) mode = 'corrected';
    const now = this.context.currentTime;
    const trim = dbToGain(preampDb);
    const targets = [[this.dry.gain, mode === 'bypass' ? 1 : 0], [this.wet.gain, mode === 'corrected' ? 1 : 0], [this.adaptive.gain, mode === 'adaptive' ? 1 : 0], ...this.retiring.map(branch => [branch.gain.gain, 0])] as [AudioParam, number][];
    for (const param of [this.preamp.gain, ...targets.map(([param]) => param)]) hold(param, now);
    if (!playing) {
      this.preamp.gain.setValueAtTime(trim, now);
      targets.forEach(([param, target]) => param.setValueAtTime(target, now));
    } else {
      // Reduce headroom gain before changing the mix; relax it only after the fade.
      const delay = preampDb < this.trimDb ? 0.01 : 0;
      if (delay) this.preamp.gain.linearRampToValueAtTime(trim, now + delay);
      for (const [param, target] of targets) {
        param.setValueAtTime(param.value, now + delay);
        param.linearRampToValueAtTime(target, now + delay + FADE_SECONDS);
      }
      if (!delay) { this.preamp.gain.setValueAtTime(this.preamp.gain.value, now + FADE_SECONDS); this.preamp.gain.linearRampToValueAtTime(trim, now + FADE_SECONDS + 0.02); }
    }
    for (const branch of [...this.retiring]) {
      if (branch.timer !== null) clearTimeout(branch.timer);
      if (playing) branch.timer = setTimeout(() => this.retire(branch), (FADE_SECONDS + 0.04) * 1000);
      else this.retire(branch);
    }
    this.trimDb = preampDb;
  }

  dispose() {
    this.input.disconnect(this.preamp); this.preamp.disconnect(); this.dry.disconnect(); this.wet.disconnect();
    this.adaptive.disconnect(); this.adaptiveFilters.forEach(node => node.disconnect());
    // Preamp was already disconnected above, so release retired nodes directly.
    this.retiring.forEach(branch => { if (branch.timer !== null) clearTimeout(branch.timer); branch.gain.disconnect(); branch.filters.forEach(node => node.disconnect()); });
    this.retiring = [];
    this.filters.forEach(node => node.disconnect());
  }
}
