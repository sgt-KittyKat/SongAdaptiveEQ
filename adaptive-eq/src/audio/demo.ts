/** An original, synthetic 16-second sound check. No downloads or recorded music. */
export function createDemoFile(): File {
  const sampleRate = 44100;
  const frames = sampleRate * 16;
  const data = new ArrayBuffer(44 + frames * 4);
  const view = new DataView(data);
  const text = (offset: number, value: string) => [...value].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, frames * 4, true);
  const chords = [[130.81, 164.81, 196], [110, 130.81, 164.81], [87.31, 110, 130.81], [98, 123.47, 146.83]];
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const chord = chords[Math.floor(t / 4) % chords.length];
    const beat = t % 0.5;
    const note = chord[Math.floor(t * 4) % 3] * 2;
    const envelope = Math.min(1, t / 0.15, (16 - t) / 0.4);
    const pad = chord.reduce((sum, hz) => sum + Math.sin(2 * Math.PI * hz * t), 0) * 0.035;
    const bass = Math.sin(2 * Math.PI * chord[0] / 2 * t) * 0.08 * Math.exp(-beat * 4);
    const pluck = Math.sin(2 * Math.PI * note * t) * Math.exp(-(t % 0.25) * 18) * 0.075;
    const kick = Math.sin(2 * Math.PI * (48 * beat + 2 * (1 - Math.exp(-beat * 30)))) * Math.exp(-beat * 28) * 0.08;
    const sample = (pad + bass + pluck + kick) * envelope;
    view.setInt16(44 + i * 4, Math.round(sample * 32767), true);
    view.setInt16(46 + i * 4, Math.round((sample * 0.96 + 0.008 * Math.sin(2 * Math.PI * note * 1.003 * t) * envelope) * 32767), true);
  }
  return new File([data], 'AdaptiveEQ - Sound check.wav', { type: 'audio/wav' });
}
