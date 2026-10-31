export type SongFixture = 'balanced' | 'bass-heavy' | 'bass-light' | 'bright' | 'dark' | 'mid-focused' | 'presence-led' | 'peak-700' | 'peak-1800';
export const SONG_FIXTURES: SongFixture[] = ['balanced', 'bass-heavy', 'bass-light', 'bright', 'dark', 'mid-focused', 'presence-led', 'peak-700', 'peak-1800'];

/** Controlled broadband multitone passages, not recordings or instrument recognition.
 * Identical phases/envelopes isolate known tonal differences between cases. */
export function songFixture(kind: SongFixture, sampleRate = 48000, seconds = 6): Float32Array {
  const data = new Float32Array(Math.round(sampleRate * seconds));
  const gaussian = (frequency: number, center: number, width: number) => Math.exp(-0.5 * (Math.log2(frequency / center) / width) ** 2);
  for (let band = 0; band < 30; band++) {
    const low = 20 * 2 ** (band / 3), high = Math.min(20000, 20 * 2 ** ((band + 1) / 3), sampleRate * 0.47);
    if (high <= low) continue;
    for (let partial = 0; partial < 7; partial++) {
      const frequency = low * (high / low) ** ((partial + 0.5) / 7);
      let db = -0.6 * Math.log2(frequency / 1000);
      if (frequency < 80) db += 6 * Math.log2(frequency / 80);
      if (frequency > 10000) db -= 6 * Math.log2(frequency / 10000);
      if (kind === 'bass-heavy' || kind === 'bass-light') db += (kind === 'bass-heavy' ? 7 : -7) * gaussian(frequency, 100, 1.3);
      if (kind === 'bright' || kind === 'dark') db += (kind === 'bright' ? 7 : -7) / (1 + Math.exp(-2 * Math.log2(frequency / 3000)));
      if (kind === 'mid-focused') db += 7 * gaussian(frequency, 650, 0.8);
      if (kind === 'presence-led') db += 7 * gaussian(frequency, 2400, 0.7);
      if (kind === 'peak-700' || kind === 'peak-1800') db += 6 * gaussian(frequency, kind === 'peak-700' ? 700 : 1800, 0.45);
      const gain = 0.012 * 10 ** (db / 20), step = 2 * Math.PI * frequency / sampleRate;
      const rotationSin = Math.sin(step), rotationCos = Math.cos(step), phase = (band * 19.131 + partial * 7.913) % (2 * Math.PI);
      let sine = Math.sin(phase), cosine = Math.cos(phase);
      for (let i = 0; i < data.length; i++) {
        data[i] += gain * sine;
        const next = sine * rotationCos + cosine * rotationSin; cosine = cosine * rotationCos - sine * rotationSin; sine = next;
      }
    }
  }
  for (let i = 0; i < data.length; i++) data[i] *= (0.9 + 0.1 * Math.sin(2 * Math.PI * i / sampleRate * 0.73)) * Math.min(1, i / (sampleRate * 0.02), (data.length - i) / (sampleRate * 0.02));
  return data;
}
