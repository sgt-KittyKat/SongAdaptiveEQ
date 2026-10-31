import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import { audioEngine, effectivePlaybackMode } from './audio/AudioEngine.ts';
import { createDemoFile } from './audio/demo.ts';
import HeadphonePanel from './HeadphonePanel.tsx';
import TrackAnalysisPanel from './TrackAnalysisPanel.tsx';
import { getProfile } from './audio/equalizer.ts';

type IconName = 'wave' | 'upload' | 'play' | 'pause' | 'back' | 'forward' | 'volume' | 'mute' | 'shield' | 'arrow' | 'close' | 'headphones' | 'file';

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    wave: <path d="M4 10v4m4-8v12m4-15v18m4-14v10m4-7v4" />,
    upload: <><path d="M12 16V4m-4 4 4-4 4 4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></>,
    play: <path d="m9 5 11 7-11 7Z" fill="currentColor" strokeWidth="0" />,
    pause: <><rect x="7" y="5" width="4" height="14" rx="1" fill="currentColor" strokeWidth="0" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" strokeWidth="0" /></>,
    back: <><path d="M3 10a9 9 0 1 1 1.5 7M3 4v6h6" /><text x="12" y="15.5" textAnchor="middle" stroke="none" fill="currentColor" fontSize="8" fontWeight="600">10</text></>,
    forward: <><path d="M21 10a9 9 0 1 0-1.5 7M21 4v6h-6" /><text x="12" y="15.5" textAnchor="middle" stroke="none" fill="currentColor" fontSize="8" fontWeight="600">10</text></>,
    volume: <><path d="m11 5-6 4H2v6h3l6 4Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></>,
    mute: <><path d="m11 5-6 4H2v6h3l6 4Zm5 4 6 6m0-6-6 6" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    headphones: <><path d="M4 14v-3a8 8 0 0 1 16 0v3" /><rect x="3" y="12" width="4" height="8" rx="2" /><rect x="17" y="12" width="4" height="8" rx="2" /></>,
    file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v6h6" /><path d="M9 17v-5l6-1v5m-6 1c0 1-3 1-3 0s3-1 3 0Zm6-1c0 1-3 1-3 0s3-1 3 0Z" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const fillStyle = (percent: number): CSSProperties => ({ '--fill': `${percent}%` }) as CSSProperties;

export default function App() {
  const state = useSyncExternalStore(audioEngine.subscribe, audioEngine.getSnapshot);
  const { track, loadingName, playing, starting, position, volume, error } = state;
  const activeMode = effectivePlaybackMode(state);
  const corrected = activeMode !== 'bypass';
  const profile = getProfile(state.profileId);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [dragError, setDragError] = useState<string | null>(null);
  const ready = !!track;
  const progress = track ? position / track.duration * 100 : 0;
  const status = loadingName ? 'Reading audio' : playing ? 'Now playing' : starting ? 'Starting audio' : track ? position >= track.duration ? 'Track finished' : 'Ready to listen' : 'Waiting for a track';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.ctrlKey || event.metaKey || event.altKey || (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, button, a')))) return;
      if (!audioEngine.getSnapshot().track) return;
      if (event.code === 'Space') { event.preventDefault(); if (!event.repeat) audioEngine.togglePlayback(); }
      if (event.code === 'ArrowLeft') { event.preventDefault(); audioEngine.skip(-5); }
      if (event.code === 'ArrowRight') { event.preventDefault(); audioEngine.skip(5); }
    };
    document.addEventListener('keydown', onKey);
    const preventFileNavigation = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', preventFileNavigation);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('dragover', preventFileNavigation);
      window.removeEventListener('drop', preventFileNavigation);
    };
  }, []);

  const load = (file: File) => {
    setDragError(null);
    void audioEngine.loadFile(file);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (event.dataTransfer.files.length !== 1) { setDragError('Drop one audio file at a time.'); return; }
    load(event.dataTransfer.files[0]);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="AdaptiveEQ home"><span className="brand-icon"><Icon name="wave" size={23} /></span><span>adaptive<span className="brand-eq">eq</span></span></a>
        <div className="topbar-right"><span className="local-badge"><span className="status-dot" />LOCAL SESSION</span><span className="version">v0.1</span></div>
      </header>

      <main id="main">
        <section className="intro" aria-labelledby="page-title">
          <div><div className="eyebrow"><span className="eyebrow-line" />YOUR LISTENING ROOM</div><h1 id="page-title">Start with a good listen<span>.</span></h1><p>Your music, a little closer. Load a track and make yourself at home.</p></div>
          <div className="chapter"><span>04</span><div>ADAPTIVE EQ<small>SHAPED BY YOUR TRACK</small></div></div>
        </section>

        <nav className="section-nav" aria-label="Listening room sections"><a href="#audio-player">01 <span>Player</span></a><a href="#headphone-correction">02 <span>Headphone EQ</span></a><a href="#track-analysis">03 <span>Track analysis</span>{state.analysis.status === 'ready' && <i className="status-dot" />}</a></nav>

        <section
          className={`player-card ${dragging ? 'is-dragging' : ''}`}
          id="audio-player"
          aria-label="Audio player"
          onDragEnter={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
          onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
          onDrop={onDrop}
        >
          <input ref={fileInput} type="file" className="visually-hidden" tabIndex={-1} aria-label="Select audio file" accept=".wav,.mp3,audio/wav,audio/mpeg" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) load(file); }} />
          {dragging && <div className="drop-overlay"><Icon name="upload" size={32} /><strong>Drop your track here</strong><span>One WAV or MP3 · up to 5 minutes</span></div>}

          <div className="player-topline"><span className="section-label">THE PLAYER</span><span className={`play-status ${playing ? 'active' : ''}`} role="status"><span className="status-dot" />{status}</span></div>

          <div className="track-area">
            <div className={`artwork ${ready ? 'has-track' : ''} ${playing ? 'is-playing' : ''}`} aria-hidden="true">
              <div className="art-corner">AE / 001</div>
              <div className="record"><div className="record-ring ring-one" /><div className="record-ring ring-two" /><div className="record-ring ring-three" /><div className="record-label"><Icon name="wave" size={35} /></div></div>
              <div className="art-bottom"><span>{track ? track.format : 'SOUND, RECONSIDERED.'}</span><span>↗</span></div>
            </div>

            <div className="track-details">
              <span className="eyebrow track-eyebrow">{loadingName ? 'GETTING THINGS READY' : track ? 'ON YOUR RECORD' : 'A LITTLE SPACE FOR YOUR MUSIC'}</span>
              <h2 className={track ? 'track-title' : ''}>{loadingName ? 'Opening your track…' : track ? track.title : 'Bring your own sound.'}</h2>
              <p className="track-description">{loadingName ? loadingName : track ? corrected ? `${activeMode === 'adaptive' ? 'Track-aware correction' : 'Measured correction'} for your ${profile?.name}.` : state.headroom.status === 'checking' ? 'Checking track peaks before applying correction…' : 'Original playback with EQ bypassed.' : 'Drop a song here or choose one from your files. Everything stays on your device.'}</p>
              {track && <div className="metadata" aria-label="Track details"><span>{track.format}</span><span>{Number((track.sampleRate / 1000).toFixed(1))} kHz playback</span><span>{track.channels === 1 ? 'Mono' : 'Stereo'}</span><span>{(track.bytes / (1024 * 1024)).toFixed(1)} MB</span></div>}
              <div className="file-actions">
                <button className={`button ${track ? 'button-secondary' : 'button-primary'}`} onClick={() => fileInput.current?.click()}><Icon name={track ? 'file' : 'upload'} size={17} />{track || loadingName ? 'Choose another track' : 'Choose a track'}{!track && !loadingName && <Icon name="arrow" size={17} />}</button>
                {!track && !loadingName && <button className="text-button demo-button" onClick={() => load(createDemoFile())}>Try a sound check<Icon name="play" size={14} /></button>}
                {(track || loadingName) && <button className="text-button clear-button" onClick={audioEngine.clear}>{loadingName ? 'Cancel' : 'Remove'}</button>}
              </div>
              {!track && !loadingName && <span className="file-hint">WAV & MP3 · up to 5 min · 64 MB max</span>}
              {loadingName && <div className="loading-line" aria-hidden="true"><span /></div>}
            </div>
          </div>

          {(error || dragError) && <div className="error-message" role="alert"><span>{dragError || error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => { setDragError(null); audioEngine.clearError(); }}><Icon name="close" size={16} /></button></div>}

          <div className="timeline">
            <div className="waveform-header"><span className="section-label">{track ? 'TRACK WAVEFORM' : 'YOUR TRACK GOES HERE'}</span><span>{track ? 'DECODED AUDIO' : 'READY WHEN YOU ARE'}</span></div>
            <div className={`waveform ${ready ? 'waveform-loaded' : ''}`}>
              {track ? <>
                <svg viewBox="0 0 1080 88" preserveAspectRatio="none" aria-hidden="true">{track.waveform.map((peak, i) => <rect key={i} x={i * 6 + 1} y={44 - Math.max(2, peak * 39)} width="3" height={Math.max(4, peak * 78)} rx="1.5" fill={i / track.waveform.length * 100 < progress ? 'var(--accent)' : '#536056'} />)}</svg>
                <div className="playhead" style={{ left: `${progress}%` }} aria-hidden="true" />
                <input type="range" className="waveform-seek" aria-label="Playback position" aria-valuetext={`${formatTime(position)} of ${formatTime(track.duration)}`} min="0" max={track.duration} step="any" value={position} onChange={(event) => audioEngine.seek(Number(event.target.value))} />
              </> : <div className="waveform-empty" aria-hidden="true"><span /><Icon name="wave" size={24} /><span /></div>}
            </div>
            <div className="time-labels"><span>{formatTime(position)}</span><span>{formatTime(track?.duration ?? 0)}</span></div>
          </div>

          <div className="transport">
            <div className="transport-info"><span className={`small-disc ${playing ? 'spinning' : ''}`} aria-hidden="true"><span /></span><div><strong>{track ? corrected ? activeMode === 'adaptive' ? 'Adaptive correction' : 'Headphone correction' : 'Original audio' : 'Nothing on the record yet'}</strong><span>{track ? corrected ? activeMode === 'adaptive' ? 'Verified track-aware EQ' : 'Measured EQ active' : 'EQ bypassed' : 'Choose a track to begin'}</span></div></div>
            <div className="playback-controls"><button className="icon-button skip-button" aria-label="Back 10 seconds" title="Back 10 seconds" disabled={!ready} onClick={() => audioEngine.skip(-10)}><Icon name="back" size={23} /></button><button className="play-button" aria-label={playing ? 'Pause' : starting ? 'Cancel playback' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'} disabled={!ready} onClick={audioEngine.togglePlayback}><Icon name={playing || starting ? 'pause' : 'play'} size={26} /></button><button className="icon-button skip-button" aria-label="Forward 10 seconds" title="Forward 10 seconds" disabled={!ready} onClick={() => audioEngine.skip(10)}><Icon name="forward" size={23} /></button></div>
            <div className="volume-control"><button className="icon-button" aria-label={volume === 0 ? 'Unmute' : 'Mute'} title={volume === 0 ? 'Unmute' : 'Mute'} onClick={audioEngine.toggleMute}><Icon name={volume === 0 ? 'mute' : 'volume'} size={19} /></button><input type="range" className="volume-slider" aria-label="Volume" min="0" max="100" step="1" value={Math.round(volume * 100)} style={fillStyle(volume * 100)} onChange={(event) => audioEngine.setVolume(Number(event.target.value) / 100)} /><span>{Math.round(volume * 100)}<span className="visually-hidden"> percent volume</span></span></div>
          </div>
        </section>

        <div className="below-player"><span><Icon name="shield" size={14} />Your files stay here. Audio is never uploaded.</span><span className="keyboard-hints"><kbd>space</kbd> play / pause<span className="hint-divider" /><kbd>←</kbd><kbd>→</kbd> seek</span></div>

        <HeadphonePanel profileId={state.profileId} mode={state.mode} activeMode={activeMode} adaptive={state.adaptive} response={state.eqResponse} headroom={state.headroom} />
        <TrackAnalysisPanel analysis={state.analysis} trackTitle={track?.title ?? null} />

        <section className="notes-grid" aria-label="About this player">
          <div className="note"><span className="note-number">01 /</span><h3>The right profile matters.</h3><p>Choose your exact model. A similar name can mean a different sound.</p></div>
          <div className="note"><span className="note-number">02 /</span><h3>Room for the peaks.</h3><p>Automatic trim makes room for EQ boosts. Switch modes to hear the difference.</p></div>
          <div className="note next-note"><div><span className="note-number">UP NEXT</span><h3>Put it to the test.</h3><p>Compare at matched loudness and find out what you prefer.</p></div><Icon name="headphones" size={26} /></div>
        </section>
      </main>

      <footer className="footer"><span>MADE FOR A BETTER LISTEN.</span><span>AdaptiveEQ <span className="footer-dot">·</span> Hackathon edition</span></footer>
    </div>
  );
}
