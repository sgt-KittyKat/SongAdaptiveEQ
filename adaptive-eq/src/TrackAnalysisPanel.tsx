import { memo, useMemo, useState } from 'react';
import { audioEngine } from './audio/AudioEngine.ts';
import type { AnalysisState, TrackAnalysis } from './audio/analysis-model.ts';

const time = (value: number) => `${Math.floor(value / 60)}:${Math.floor(value % 60).toString().padStart(2, '0')}`;
const percent = (value: number) => value > 0 && value < 0.05 ? '<0.1%' : `${value.toFixed(1)}%`;
const level = (value: number | null, unit = ' dBFS') => value === null ? `−∞${unit}` : `${value.toFixed(1).replace('-', '−')}${unit}`;
const frequency = (value: number) => value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(Math.round(value));
const groupClass = (index: number) => index < 2 ? 'band-bass' : index < 6 ? 'band-mids' : 'band-treble';
const groups = (values: number[]) => [values[0] + values[1], values.slice(2, 6).reduce((sum, value) => sum + value, 0), values[6] + values[7]];

function FrequencyTimeline({ result }: { result: TrackAnalysis }) {
  const [selected, setSelected] = useState(0);
  const sections = useMemo(() => result.sections.map(section => ({ ...section, groups: groups(section.energyPercent) })), [result]);
  const index = Math.min(selected, sections.length - 1);
  const section = sections[index];
  return <div className="frequency-timeline">
    <div className="analysis-subheading"><h3>Across the recording</h3><span>{sections.length} measured sections</span></div>
    <div className="analysis-group-legend"><span><i className="band-bass" />Bass <small>20–150 Hz</small></span><span><i className="band-mids" />Mids <small>150 Hz–{frequency(Math.min(5000, result.sampleRate / 2))}</small></span><span><i className="band-treble" />Treble <small>{result.sampleRate / 2 > 5000 ? `5k–${frequency(Math.min(20000, result.sampleRate / 2))}` : 'Outside bandwidth'}</small></span></div>
    <div className="analysis-timeline-strip" onPointerMove={event => { const box = event.currentTarget.getBoundingClientRect(); setSelected(Math.max(0, Math.min(sections.length - 1, Math.floor((event.clientX - box.left) / box.width * sections.length)))); }}>
      <div className="analysis-section-bars" role="img" aria-label="Relative bass, midrange, and treble power across the entire track. Inspect a section for its values.">
        {sections.map((item, i) => <div className={`analysis-timebar ${index === i ? 'inspected' : ''}`} key={i} style={{ opacity: item.activeFraction > 0 ? 0.6 + 0.4 * item.activeFraction : 0.25 }}>{item.groups.map((value, group) => <span key={group} className={groupClass(group === 0 ? 0 : group === 1 ? 2 : 6)} style={{ height: `${value}%` }} />)}</div>)}
      </div>
      <input type="range" className="analysis-time-inspector" aria-label="Inspect analysis time" aria-valuetext={`${time(section.startSeconds)} to ${time(section.endSeconds)}. Bass ${percent(section.groups[0])}, mids ${percent(section.groups[1])}, treble ${percent(section.groups[2])}.`} min="0" max={Math.max(0, sections.length - 1)} step="1" value={index} disabled={sections.length < 2} onChange={event => setSelected(Number(event.target.value))} />
    </div>
    <div className="analysis-time-axis"><span>0:00</span><span>{time(result.duration / 2)}</span><span>{time(result.duration)}</span></div>
    <div className="analysis-section-readout"><strong>{time(section.startSeconds)}–{time(section.endSeconds)}</strong>{section.activeFraction > 0 ? <><span>Bass {percent(section.groups[0])}</span><span>Mids {percent(section.groups[1])}</span><span>Treble {percent(section.groups[2])}</span></> : <span>No frames above the analysis gate.</span>}</div>
  </div>;
}

function downloadAnalysis(result: TrackAnalysis, title: string) {
  const file = new Blob([JSON.stringify({ track: title, ...result }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(file), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80) || 'track'}-analysis.json`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default memo(function TrackAnalysisPanel({ analysis, trackTitle }: { analysis: AnalysisState; trackTitle: string | null }) {
  const { status, progress, result, error } = analysis;
  const leading = result?.hasContent ? result.bands.reduce((top, band) => band.energyPercent > top.energyPercent ? band : top) : null;
  return <section className="analysis-card" id="track-analysis" aria-labelledby="analysis-title">
    <div className="eq-card-header"><div><div className="eyebrow">03 / UNDERSTAND THE RECORDING</div><h2 id="analysis-title">Inside your track.</h2><p>The original audio, measured across the full recording.</p></div><span className={`eq-mode-badge ${status === 'ready' ? 'enabled' : ''}`} role="status"><span className="status-dot" />{status === 'running' ? `Analyzing · ${Math.round(progress * 100)}%` : status === 'ready' ? 'Analysis ready' : status === 'cancelled' ? 'Analysis cancelled' : status === 'error' ? 'Analysis unavailable' : 'Waiting for audio'}</span></div>

    {status === 'running' && <div className="analysis-progress-state"><div className="analysis-progress-top"><span>{progress < 0.2 ? 'Reading original samples…' : 'Measuring frequency content…'}</span><button className="text-button" onClick={audioEngine.cancelAnalysis}>Cancel analysis</button></div><div className="analysis-progress" role="progressbar" aria-label="Track analysis progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><span style={{ width: `${progress * 100}%` }} /></div><p>Playback controls stay available while analysis runs on your device.</p></div>}

    {status === 'idle' && <div className="analysis-empty"><span className="analysis-empty-mark" aria-hidden="true">∿</span><div><h3>A little more insight into every listen.</h3><p>Load a track to see its frequency balance, level, and changes over time. Analysis starts automatically.</p></div></div>}
    {(status === 'cancelled' || status === 'error') && <div className="analysis-empty"><div><h3>{status === 'cancelled' ? 'Pick up where you left off.' : 'The player is still ready to listen.'}</h3><p role={status === 'error' ? 'alert' : undefined}>{error || 'Analysis was cancelled. You can start a fresh pass at any time.'}</p><button className="button button-secondary" disabled={!trackTitle} onClick={audioEngine.analyzeTrack}>{status === 'error' ? 'Retry analysis' : 'Analyze track'}</button></div></div>}

    {status === 'ready' && result && <>
      <div className="analysis-summary"><p>{leading ? <>The largest measured energy share is in <strong>{leading.name.toLowerCase()}</strong> ({percent(leading.energyPercent)}).</> : result.rmsDbfs === null ? 'This recording contains only silence.' : 'No measurable changing signal was found in the analyzed frequency range.'}</p><button className="text-button" onClick={() => downloadAnalysis(result, trackTitle || 'track')}>Save analysis ↓</button></div>
      {result.duration < 1 && <p className="analysis-short-note">This is a very short clip; its frequency detail is limited.</p>}
      <div className="analysis-levels" aria-label="Original signal statistics"><div><span>SOURCE RMS LEVEL</span><strong>{level(result.rmsDbfs)}</strong><small>Unprocessed signal level</small></div><div><span>SOURCE SAMPLE PEAK</span><strong>{level(result.samplePeakDbfs)}</strong><small>Before EQ and safety trim</small></div><div><span>CREST FACTOR</span><strong>{result.crestDb === null ? '—' : level(result.crestDb, ' dB')}</strong><small>Peak relative to RMS</small></div><div><span>ANALYZED FRAMES</span><strong>{result.analyzedFrames.toLocaleString()}<small> / {result.totalFrames.toLocaleString()}</small></strong><small>Above the relative gate</small></div></div>

      {result.spectral && <div className="spectral-summary" aria-label="Detailed spectral analysis"><span><small>SONG EQ RESOLUTION</small><strong>{result.spectral.bands.length} spectral regions</strong></span><span><small>POWER / OCTAVE TILT</small><strong>{result.spectral.tiltDbPerOctave === null ? 'Insufficient support' : `${result.spectral.tiltDbPerOctave.toFixed(2)} dB / oct`}</strong></span><span><small>MEDIAN PEAK / VALLEY CONTRAST</small><strong>{result.spectral.contrastDb.toFixed(1)} dB</strong></span><p>The song EQ uses persistent one-third-octave detail. The eight bands below summarize overall energy; short loud events have less influence on the song EQ.</p></div>}
      <div className="analysis-subheading"><h3>Frequency distribution</h3><span>Share of analyzed band power</span></div>
      <div className="analysis-band-grid" aria-label="Frequency-band energy and activity">{result.bands.map((band, i) => <article className={`analysis-band ${groupClass(i)} ${!band.available ? 'unavailable' : ''}`} key={band.id}><div className="analysis-band-label"><h4>{band.name}</h4><span>{band.available ? `${frequency(band.lowHz)}–${frequency(band.highHz)} Hz` : 'Outside playback bandwidth'}</span></div><strong>{band.available ? percent(band.energyPercent) : '—'}</strong><div className="analysis-band-meter" aria-hidden="true"><span style={{ width: `${band.energyPercent}%` }} /></div><p>Band activity <span>{band.available ? `${Math.round(band.activityPercent)}%` : '—'}</span></p></article>)}</div>

      {result.hasContent && <FrequencyTimeline result={result} />}
      <div className="eq-footnote"><span className="status-dot" /><p>Energy and activity describe what is present in the recording. They do not identify instruments or establish that a frequency needs correction.</p></div>
      <details className="profile-details analysis-method"><summary>How these measurements are calculated</summary><ul><li>Meyda power spectra use {result.fftSize.toLocaleString()}-sample Hann windows with 50% overlap, across the entire track. Bin spacing at this playback rate is {result.frequencyResolutionHz.toFixed(2)} Hz.</li><li>Channel powers are averaged independently. The whole-track DC mean is removed for spectral analysis; source RMS, peak, and crest use the original samples.</li><li>Frames more than {Math.abs(result.silenceGateDb)} dB below the strongest frame’s RMS are excluded. Band activity is the percentage of analyzed frames where a band carries at least {result.activityPowerFraction * 100}% of the measured band power.</li><li>Energy shares are integrated powers over broad bands, rather than power per hertz. Larger frequency ranges can contain more energy. These are measurements of the decoded recording, independent of player volume and headphone settings.</li><li>Crest factor is peak divided by RMS; it is not a complete measure of musical dynamics. RMS is not LUFS or a perceived-loudness measurement.</li></ul><div className="filter-table-wrap"><table><caption>Median and variation summarize each band’s frame-by-frame share. Variation is standard deviation in percentage points.</caption><thead><tr><th>Band</th><th>Energy</th><th>Activity</th><th>Median share</th><th>Variation</th></tr></thead><tbody>{result.bands.map(band => <tr key={band.id}><td>{band.name}</td><td>{percent(band.energyPercent)}</td><td>{percent(band.activityPercent)}</td><td>{percent(band.medianSharePercent)}</td><td>{band.variationPercentPoints.toFixed(1)} pp</td></tr>)}</tbody></table></div></details>
    </>}
  </section>;
});
