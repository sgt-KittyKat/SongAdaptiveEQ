class FakeParam {
  constructor(value = 1) { this.value = value; this.events = []; }
  setValueAtTime(value, time) { this.value = value; this.events.push(['set', value, time]); }
  linearRampToValueAtTime(value, time) { this.value = value; this.events.push(['ramp', value, time]); }
  setTargetAtTime(value, time) { this.value = value; this.events.push(['target', value, time]); }
  cancelAndHoldAtTime(time) { this.events.push(['hold', time]); }
}
class FakeNode {
  connections = [];
  connect(node) { this.connections.push(node); return node; }
  disconnect(target) { this.connections = target ? this.connections.filter(node => node !== target) : []; }
}
function magnitude(b, a, frequency, sampleRate) {
  const w = 2 * Math.PI * frequency / sampleRate;
  const power = (coefficients) => {
    const real = coefficients.reduce((sum, value, i) => sum + value * Math.cos(w * i), 0);
    const imag = coefficients.reduce((sum, value, i) => sum - value * Math.sin(w * i), 0);
    return real * real + imag * imag;
  };
  return Math.sqrt(power(b) / power(a));
}
class FakeFilter extends FakeNode {
  constructor(context, coefficients = null) {
    super(); this.context = context; this.coefficients = coefficients;
    this.frequency = new FakeParam(350); this.gain = new FakeParam(0); this.Q = new FakeParam(1); this.type = 'peaking';
  }
  getFrequencyResponse(frequencies, magnitudes, phases) {
    let b, a;
    if (this.coefficients) [b, a] = this.coefficients;
    else {
      const A = 10 ** (this.gain.value / 40), w = 2 * Math.PI * this.frequency.value / this.context.sampleRate;
      const alpha = Math.sin(w) / (2 * this.Q.value), c = Math.cos(w);
      b = [1 + alpha * A, -2 * c, 1 - alpha * A];
      a = [1 + alpha / A, -2 * c, 1 - alpha / A];
    }
    frequencies.forEach((frequency, i) => { magnitudes[i] = magnitude(b, a, frequency, this.context.sampleRate); phases[i] = 0; });
  }
}
export class FakeContext {
  currentTime = 0; sampleRate = 48000; state = 'suspended'; destination = new FakeNode();
  sources = []; gains = []; filters = [];
  decodeAudioData = async () => ({ duration: 60, sampleRate: 48000, numberOfChannels: 1, length: 4, getChannelData: () => new Float32Array([0, 0.2, -0.8, 0.3]) });
  resume = async () => { this.state = 'running'; };
  close = async () => { this.state = 'closed'; };
  createGain() { const node = new FakeNode(); node.gain = new FakeParam(); this.gains.push(node); return node; }
  createBiquadFilter() { const node = new FakeFilter(this); this.filters.push(node); return node; }
  createIIRFilter(b, a) { const node = new FakeFilter(this, [b, a]); this.filters.push(node); return node; }
  createBufferSource() {
    const node = new FakeNode();
    Object.assign(node, { buffer: null, onended: null, stopped: false, offset: null,
      start(_time, offset) { this.offset = offset; }, stop() { this.stopped = true; this.onended?.(); } });
    this.sources.push(node); return node;
  }
  get activeSources() { return this.sources.filter(node => !node.stopped); }
}
