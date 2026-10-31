import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine, waveformPeaks, MAX_FILE_BYTES } from '../src/audio/AudioEngine.ts';
import { createDemoFile } from '../src/audio/demo.ts';
import { FakeContext } from './fake-audio.mjs';

function buffer(duration = 60, channelData = [new Float32Array([0, 0.2, -0.8, 0.3])]) {
  return { duration, sampleRate: 48000, numberOfChannels: channelData.length, length: channelData[0].length, getChannelData: (i) => channelData[i] };
}

const file = (name = 'song.wav', size = 44) => ({ name, size, arrayBuffer: async () => new ArrayBuffer(size) });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function setup(t) {
  const context = new FakeContext();
  const engine = new AudioEngine(() => context, async () => null);
  t.after(() => engine.dispose());
  return { context, engine };
}

test('pause and resume preserve elapsed audio time without overlapping sources', async (t) => {
  const { context, engine } = setup(t);
  await engine.loadFile(file());
  await engine.play();
  context.currentTime = 12;
  engine.pause();
  assert.equal(engine.getSnapshot().position, 12);
  assert.equal(context.activeSources.length, 0);
  context.currentTime = 20;
  await engine.play();
  await engine.play();
  assert.equal(context.activeSources.length, 1);
  assert.equal(context.activeSources[0].offset, 12);
  context.currentTime = 25;
  engine.pause();
  assert.equal(engine.getSnapshot().position, 17);
});

test('seeking while playing replaces the source and clamps track boundaries', async (t) => {
  const { context, engine } = setup(t);
  await engine.loadFile(file());
  await engine.play();
  engine.seek(30);
  assert.equal(context.activeSources.length, 1);
  assert.equal(context.activeSources[0].offset, 30);
  engine.seek(-50);
  assert.equal(context.activeSources.length, 1);
  assert.equal(context.activeSources[0].offset, 0);
  engine.seek(500);
  assert.equal(engine.getSnapshot().position, 60);
  assert.equal(engine.getSnapshot().playing, false);
  assert.equal(context.activeSources.length, 0);
  await engine.play();
  assert.equal(context.activeSources[0].offset, 0);
});

test('a natural end leaves a replayable track at its exact duration', async (t) => {
  const { context, engine } = setup(t);
  await engine.loadFile(file());
  await engine.play();
  const source = context.sources[0];
  source.stopped = true;
  source.onended();
  assert.equal(engine.getSnapshot().playing, false);
  assert.equal(engine.getSnapshot().position, 60);
  await engine.play();
  assert.equal(context.activeSources[0].offset, 0);
});

test('the newest file wins even when an older decode completes later', async (t) => {
  const { context, engine } = setup(t);
  const first = deferred();
  const second = deferred();
  let calls = 0;
  context.decodeAudioData = () => (++calls === 1 ? first.promise : second.promise);
  const loadFirst = engine.loadFile(file('first.wav'));
  await Promise.resolve();
  await Promise.resolve();
  const loadSecond = engine.loadFile(file('second.mp3'));
  await Promise.resolve();
  await Promise.resolve();
  second.resolve(buffer(45));
  await loadSecond;
  first.resolve(buffer(90));
  await loadFirst;
  assert.equal(engine.getSnapshot().track.name, 'second.mp3');
  assert.equal(engine.getSnapshot().track.duration, 45);
  assert.equal(engine.getAudioBuffer().duration, 45);
});

test('replacing a playing track stops its source and does not autoplay the replacement', async (t) => {
  const { context, engine } = setup(t);
  await engine.loadFile(file('first.wav'));
  await engine.play();
  await engine.loadFile(file('next.wav'));
  assert.equal(context.activeSources.length, 0);
  assert.equal(engine.getSnapshot().position, 0);
  assert.equal(engine.getSnapshot().playing, false);
  assert.equal(engine.getSnapshot().track.name, 'next.wav');
});

test('cancel invalidates a pending decode and a pending browser resume', async (t) => {
  const { context, engine } = setup(t);
  const decoding = deferred();
  context.decodeAudioData = () => decoding.promise;
  const loading = engine.loadFile(file());
  await Promise.resolve();
  await Promise.resolve();
  engine.clear();
  decoding.resolve(buffer());
  await loading;
  assert.equal(engine.getSnapshot().track, null);
  context.decodeAudioData = async () => buffer();
  await engine.loadFile(file());
  const resuming = deferred();
  context.resume = () => resuming.promise;
  const playing = engine.play();
  engine.pause();
  context.state = 'running';
  resuming.resolve();
  await playing;
  assert.equal(context.activeSources.length, 0);
  assert.equal(engine.getSnapshot().starting, false);
});

test('invalid, empty, oversized, long, multichannel, and corrupt files fail cleanly', async (t) => {
  const { context, engine } = setup(t);
  for (const [input, pattern] of [[file('text.txt'), /WAV or MP3/], [file('empty.wav', 0), /empty/], [file('large.wav', MAX_FILE_BYTES + 1), /too large/]]) {
    await engine.loadFile(input);
    assert.match(engine.getSnapshot().error, pattern);
    assert.equal(engine.getSnapshot().loadingName, null);
    assert.equal(engine.getSnapshot().track, null);
  }
  context.decodeAudioData = async () => buffer(301);
  await engine.loadFile(file());
  assert.match(engine.getSnapshot().error, /5 minutes/);
  context.decodeAudioData = async () => buffer(10, Array.from({ length: 6 }, () => new Float32Array([0])));
  await engine.loadFile(file());
  assert.match(engine.getSnapshot().error, /mono or stereo/);
  context.decodeAudioData = async () => { throw new Error('decode failed'); };
  await engine.loadFile(file());
  assert.match(engine.getSnapshot().error, /could not read/);
  assert.equal(engine.getAudioBuffer(), null);
  context.decodeAudioData = async () => buffer();
  await engine.loadFile(file());
  assert.equal(engine.getSnapshot().error, null);
  assert.ok(engine.getSnapshot().track);
});

test('muting restores the previous volume and updates the audio gain', async (t) => {
  const { context, engine } = setup(t);
  await engine.loadFile(file());
  engine.setVolume(0.4);
  engine.toggleMute();
  assert.equal(engine.getSnapshot().volume, 0);
  assert.equal(context.gains[1].gain.value, 0);
  engine.toggleMute();
  assert.equal(engine.getSnapshot().volume, 0.4);
  assert.equal(context.gains[1].gain.value, 0.4);
});

test('waveform peaks preserve opposite-phase stereo content and handle silence', () => {
  const stereo = buffer(1, [new Float32Array([0, 0.5, -1, 0]), new Float32Array([0, -0.5, 1, 0])]);
  assert.deepEqual(waveformPeaks(stereo, 2), [0.5, 1]);
  assert.deepEqual(waveformPeaks(buffer(1, [new Float32Array(4)]), 2), [0, 0]);
});

test('the built-in sound check is a valid-length stereo PCM WAV with headroom', async () => {
  const demo = createDemoFile();
  const bytes = await demo.arrayBuffer();
  const view = new DataView(bytes);
  assert.equal(demo.name, 'AdaptiveEQ - Sound check.wav');
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(4, true), bytes.byteLength - 8);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal((bytes.byteLength - 44) / (44100 * 4), 16);
  let peak = 0;
  for (let offset = 44; offset < bytes.byteLength; offset += 2) peak = Math.max(peak, Math.abs(view.getInt16(offset, true)));
  assert.ok(peak > 0 && peak < 32767);
});

test('long compressed recordings are rejected before reading and decoding their PCM', async (t) => {
  const context = new FakeContext();
  const engine = new AudioEngine(() => context, async () => 3600);
  t.after(() => engine.dispose());
  let reads = 0;
  await engine.loadFile({ ...file('long.mp3'), arrayBuffer: async () => { reads++; return new ArrayBuffer(44); } });
  assert.match(engine.getSnapshot().error, /5 minutes/);
  assert.equal(reads, 0);
});

test('clearing a track aborts its pending metadata probe', async (t) => {
  const context = new FakeContext();
  let signal;
  const metadata = deferred();
  const engine = new AudioEngine(() => context, async (_file, abortSignal) => { signal = abortSignal; return metadata.promise; });
  t.after(() => engine.dispose());
  const loading = engine.loadFile(file());
  engine.clear();
  assert.equal(signal.aborted, true);
  metadata.resolve(30);
  await loading;
  assert.equal(engine.getSnapshot().track, null);
});

test('seeking during browser resume keeps the play intent at the new position', async (t) => {
  const { context, engine } = setup(t);
  await engine.loadFile(file());
  const resuming = deferred();
  context.resume = async () => { await resuming.promise; context.state = 'running'; };
  const playing = engine.play();
  engine.seek(30);
  resuming.resolve();
  await playing;
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(engine.getSnapshot().playing, true);
  assert.equal(context.activeSources.length, 1);
  assert.equal(context.activeSources[0].offset, 30);
});
