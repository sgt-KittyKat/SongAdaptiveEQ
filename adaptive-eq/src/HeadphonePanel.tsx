import { memo, useEffect, useMemo, useState } from 'react';
import { audioEngine } from './audio/AudioEngine.ts';
import type { HeadroomState } from './audio/AudioEngine.ts';
import { getProfile, HEADPHONE_PROFILES } from './audio/equalizer.ts';
import type { EqResponse, PlaybackMode } from './audio/equalizer.ts';
import type { AdaptiveState } from './audio/adaptive.ts';

const db = (value: number, suffix = ' dB') => `${value === -Infinity ? '−∞' : `${value > 0 ? '+' : ''}${value.toFixed(1).replace('-', '−')}`}${suffix}`;
const hz = (value: number) => value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : `${Math.round(value)}`;

function EqGraph({ response, adaptiveResponse, preampDb, mode }: { response: EqResponse | null; adaptiveResponse: EqResponse | null; preampDb: number; mode: PlaybackMode }) {
  const [inspect, setInspect] = useState(0.56);
  const graph = useMemo(() => {
    const frequencies = response?.frequencies ?? [20, 20000];
    const curve = response?.correctionDb ?? [0, 0];
    const adaptive = adaptiveResponse?.correctionDb ?? curve;
    const applied = curve.map((value, i) => (mode === 'adaptive' ? adaptive[i] : mode === 'corrected' ? value : 0) + preampDb);
    const min = Math.min(-12, Math.floor((Math.min(...applied, ...curve, ...adaptive) - 1) / 6) * 6);
    const max = Math.max(6, Math.ceil(Math.max(...curve, ...adaptive) / 6) * 6);
    const maxFrequency = Math.min(20000, (response?.sampleRate ?? 48000) * 0.49);
    const x = (frequency: number) => Math.log(frequency / 20) / Math.log(maxFrequency / 20) * 760;
    const y = (gain: number) => (max - gain) / (max - min) * 200;
    const path = (values: number[]) => frequencies.map((frequency, i) => `${i ? 'L' : 'M'}${x(frequency).toFixed(2)},${y(values[i]).toFixed(2)}`).join(' ');
    const ticks = Array.from({ length: (max - min) / 6 + 1 }, (_, i) => max - i * 6);
    return { frequencies, curve, adaptive, applied, min, max, x, y, path, ticks, maxFrequency };
  }, [response, adaptiveResponse, preampDb, mode]);
  const index = Math.min(graph.frequencies.length - 1, Math.round(inspect * (graph.frequencies.length - 1)));
  const inspectedX = graph.x(graph.frequencies[index]) / 760 * 100;
  const xTicks = [20, 100, 1000, 10000, 20000].filter(value => value <= graph.maxFrequency);

  return <div className="eq-graph-wrap">
    <div className="eq-legend"><span><i className="legend-profile" />Measured</span>{adaptiveResponse && <span><i className="legend-adaptive" />Adaptive</span>}<span><i className="legend-applied" />Applied + trim</span><small>dB</small></div>
    <div className="eq-graph" onPointerMove={(event) => { const box = event.currentTarget.getBoundingClientRect(); setInspect(Math.max(0, Math.min(1, (event.clientX - box.left - 32) / (box.width - 32)))); }}>
      <div className="eq-y-labels" aria-hidden="true">{graph.ticks.map(tick => <span key={tick} style={{ top: `${graph.y(tick) / 2}%` }}>{tick > 0 ? '+' : ''}{tick}</span>)}</div>
      <div className="eq-plot">
        <svg viewBox="0 0 760 200" preserveAspectRatio="none" role="img" aria-label={response ? `Measured and adaptive headphone EQ response. ${mode} playback. Shared preamp ${preampDb.toFixed(1)} decibels.` : 'Flat bypass response. Select a supported headphone profile to see its correction.'}>
          <defs><linearGradient id="eq-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#c8ed9a" stopOpacity="0.13" /><stop offset="100%" stopColor="#c8ed9a" stopOpacity="0" /></linearGradient></defs>
          {graph.ticks.map(tick => <line key={tick} x1="0" x2="760" y1={graph.y(tick)} y2={graph.y(tick)} stroke={tick === 0 ? '#59654b' : '#323b2b'} strokeDasharray={tick === 0 ? '4 5' : undefined} vectorEffect="non-scaling-stroke" />)}
          {xTicks.map(tick => <line key={tick} x1={graph.x(tick)} x2={graph.x(tick)} y1="0" y2="200" stroke="#30392a" vectorEffect="non-scaling-stroke" />)}
          {response && <path d={graph.path(graph.curve)} fill="none" stroke="#81946d" strokeWidth="1.5" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
          {adaptiveResponse && <path d={graph.path(graph.adaptive)} fill="none" stroke="#84cfc1" strokeWidth="1.7" vectorEffect="non-scaling-stroke" />}
          <path d={`${graph.path(graph.applied)} L760,200 L0,200 Z`} fill="url(#eq-fill)" />
          <path d={graph.path(graph.applied)} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          {response && <line x1={graph.x(graph.frequencies[index])} x2={graph.x(graph.frequencies[index])} y1="0" y2="200" stroke="#a5b98c" strokeOpacity="0.35" vectorEffect="non-scaling-stroke" />}
        </svg>
        {response && <span className="eq-inspection-dot" style={{ left: `${inspectedX}%`, top: `${graph.y(graph.applied[index]) / 2}%` }} aria-hidden="true" />}
        {response && <input type="range" className="eq-inspector" aria-label="Inspect EQ frequency" aria-valuetext={`${Math.round(graph.frequencies[index])} hertz, applied ${graph.applied[index].toFixed(1)} decibels`} min="0" max="1000" value={Math.round(inspect * 1000)} onChange={event => setInspect(Number(event.target.value) / 1000)} />}
        {!response && <span className="eq-graph-empty">Your headphone profile goes here.</span>}
      </div>
    </div>
    <div className="eq-x-labels" aria-hidden="true">{xTicks.map(tick => <span key={tick} className={tick === 10000 ? 'eq-ten-k' : undefined} style={{ left: `${graph.x(tick) / 760 * 100}%` }}>{hz(tick)}{tick === 20000 ? ' Hz' : ''}</span>)}</div>
    <div className="eq-inspector-readout">{response ? <><strong>{hz(graph.frequencies[index])} Hz</strong><span>Measured {db(graph.curve[index])}</span>{adaptiveResponse && <span>Adaptive {db(graph.adaptive[index])}</span>}<span>Applied {db(graph.applied[index])}</span></> : <span>Select your exact headphone model to enable correction.</span>}</div>
  </div>;
}

interface Props { profileId: string; mode: PlaybackMode; activeMode: PlaybackMode; adaptive: AdaptiveState; response: EqResponse | null; headroom: HeadroomState }
export default memo(function HeadphonePanel({ profileId, mode, activeMode, adaptive, response, headroom }: Props) {
  const profile = getProfile(profileId);
  const active = activeMode !== 'bypass';
  const [strength, setStrength] = useState(Math.round(adaptive.strength * 100));
  useEffect(() => setStrength(Math.round(adaptive.strength * 100)), [adaptive.strength]);
  const commitStrength = () => audioEngine.setAdaptiveStrength(strength / 100);
  const plan = adaptive.plan;
  const peak = activeMode === 'adaptive' ? headroom.adaptivePeakDb ?? null : active ? headroom.correctedPeakDb : headroom.originalPeakDb;
  const changes = plan?.changes.filter(item => Math.abs(item.adaptiveGainDb - item.baseGainDb) >= 0.05).sort((a, b) => Math.abs(b.adaptiveGainDb - b.baseGainDb) - Math.abs(a.adaptiveGainDb - a.baseGainDb)).slice(0, 3) ?? [];
  const activeResponse = activeMode === 'adaptive' ? plan?.response ?? response : response;
  const badge = headroom.status === 'checking' ? 'Checking track peaks' : activeMode === 'adaptive' ? 'Adaptive on' : active ? mode === 'adaptive' ? 'Measured EQ in use' : 'Measured EQ on' : 'EQ bypassed';
  return <section className="eq-card" id="headphone-correction" aria-labelledby="eq-title">
    <div className="eq-card-header"><div><div className="eyebrow">02 / MADE FOR YOUR HEADPHONES</div><h2 id="eq-title">A better fit for your sound.</h2><p>Measured headphone correction. A little more aware of your track.</p></div><span className={`eq-mode-badge ${active ? 'enabled' : ''}`} role="status"><span className="status-dot" />{badge}</span></div>
    <div className="eq-controls">
      <div className="profile-field"><label htmlFor="headphone-model">HEADPHONE MODEL</label><select id="headphone-model" value={profileId} onChange={event => audioEngine.selectProfile(event.target.value)}><option value="none">No correction / other headphones</option>{HEADPHONE_PROFILES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option disabled value="marshall-major-v">Marshall Major V — profile unavailable</option></select></div>
      <div className="eq-mode-control" role="group" aria-label="EQ playback mode">{(['bypass', 'corrected', 'adaptive'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} disabled={!profile} onClick={() => audioEngine.setPlaybackMode(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
    </div>
    <p className="profile-help">Selection applies an EQ profile. Choose the matching physical output in Windows.</p>
    <div className={`adaptive-panel ${!profile ? 'is-unavailable' : ''}`}>
      <div className="adaptive-heading"><div><span className="adaptive-tag">EXPERIMENTAL</span><h3>Let the track shape the correction.</h3></div><span className="adaptive-limit">≤ 2 dB curve change</span></div>
      <p>Regions with more relative energy and activity keep more of the measured correction. Quieter regions ease toward neutral. This is a heuristic to audition, not a prediction of better sound.</p>
      <div className="adaptive-strength"><label htmlFor="adaptive-strength">Adaptive strength <strong>{strength}%</strong></label><input id="adaptive-strength" type="range" min="0" max="100" step="1" value={strength} disabled={!profile} aria-valuetext={`${strength} percent. Zero reproduces measured correction.`} onChange={event => setStrength(Number(event.target.value))} onPointerUp={commitStrength} onKeyUp={commitStrength} onBlur={commitStrength} /><div className="adaptive-range-labels"><span>Measured EQ</span><span>Track aware</span></div></div>
      <div className="adaptive-status" role="status">{!profile ? 'Choose a supported headphone model to try Adaptive.' : headroom.status === 'checking' ? 'Checking measured correction first. Adaptive follows when analysis is ready.' : adaptive.status === 'checking' ? `Checking ${Math.round(adaptive.strength * 100)}% strength. Playback keeps the last verified setting, or measured EQ.` : adaptive.status === 'error' ? `New setting could not be checked. ${plan?.status === 'ready' && plan.maxDeltaDb > 0 ? 'The last verified adaptive setting is retained.' : 'Measured EQ is in use.'}` : plan?.reason ?? (plan ? `Verified setting: ${Math.round(plan.requestedStrength * 100)}% strength · maximum curve change ${plan.maxDeltaDb.toFixed(2)} dB${plan.appliedStrength < plan.requestedStrength - 0.001 ? ' · limited to stay within 2 dB' : ''}.` : 'Load a track to calculate its adaptive correction.')}</div>
      {adaptive.error && <div className="adaptive-error"><span>{adaptive.error}</span><button type="button" className="text-button" onClick={() => audioEngine.retryAdaptive()}>Retry check</button></div>}
      {!!changes.length && <div className="adaptive-changes" aria-label="Verified adaptive filter changes">{changes.map(change => <div key={change.index}><span>{hz(change.frequency)} Hz <small>{change.type === 'peaking' ? 'peak' : change.type === 'lowshelf' ? 'low shelf' : 'high shelf'}</small></span><strong>{db(change.baseGainDb)} <i>→</i> {db(change.adaptiveGainDb)}</strong><p>{Math.round(change.retainedPercent)}% of correction retained · {Math.round(change.relevance * 100)}% content relevance across its affected region</p></div>)}</div>}
      {!!plan?.bands.length && <details className="adaptive-method"><summary>How this track shaped the setting</summary><p>Relevance combines relative band energy and activity equally. Each filter averages relevance across its response on a logarithmic frequency grid. Gains retain 70–100% of their measured values; frequencies and Q stay fixed. The full combined response is then checked at 4,098 frequencies, including DC and Nyquist, and the change is reduced if it exceeds 2 dB.</p><div className="filter-table-wrap"><table><thead><tr><th>Track region</th><th>Energy</th><th>Activity</th><th>Relevance</th></tr></thead><tbody>{plan.bands.map(band => <tr key={band.lowHz}><td>{band.name}<small> {hz(band.lowHz)}–{hz(band.highHz)} Hz</small></td><td>{band.energyPercent.toFixed(1)}%</td><td>{band.activityPercent.toFixed(1)}%</td><td>{Math.round(band.relevance * 100)}%</td></tr>)}</tbody></table></div><p>Energy is a share of analyzed 20 Hz–20 kHz power. Activity is the share of non-silent frames above the analysis threshold. Neither identifies instruments or musical importance.</p></details>}
    </div>
    <EqGraph response={response} adaptiveResponse={plan?.response ?? null} preampDb={headroom.preampDb} mode={activeMode} />
    <div className="headroom-grid" aria-label="Headroom details">
      <div><span>SHARED SAFETY TRIM</span><strong>{db(headroom.preampDb)}</strong><small>Same gain in all three modes</small></div>
      <div><span>MAXIMUM PROFILE BOOST</span><strong>{activeResponse ? db(activeResponse.peakBoostDb) : '—'}</strong><small>{activeMode === 'adaptive' ? 'Verified adaptive profile' : 'Measured headphone profile'} · full range</small></div>
      <div><span>{activeMode.toUpperCase()} SAMPLE PEAK</span><strong>{headroom.status === 'checking' ? 'Checking…' : peak !== null ? db(peak, ' dBFS') : '—'}</strong><small>{headroom.status === 'checked' ? 'Whole track · before volume' : 'Load audio to check its peaks'}</small></div>
    </div>
    {headroom.error && <div className="eq-error" role="alert">Correction is bypassed: {headroom.error} Choose Corrected to retry.</div>}
    <div className="eq-footnote"><span className="status-dot" /><p>{profile ? 'Bypass keeps the safety trim. This comparison is not loudness matched yet. Peak checks measure digital samples, not true peaks or headphone output limits.' : 'Choose a supported model to apply its measured profile. Other headphones can use original playback.'}</p></div>
    {profile && <details className="profile-details"><summary>{profile.filters.length} filters · measurement source & settings</summary><p>Model-average correction generated by <a href={profile.provenance.repository} target="_blank" rel="noreferrer">AutoEq</a> from {profile.measurementSource} measurements on {profile.measurementRig}. Use this exact model with vendor EQ and spatial effects off. Fit and individual units can differ.</p><div className="profile-source-links"><a href={profile.provenance.sourceUrl} target="_blank" rel="noreferrer">Pinned source ↗</a><a href={profile.provenance.presetUrl} target="_blank" rel="noreferrer">Original preset ↗</a><a href={profile.provenance.licenseUrl} target="_blank" rel="noreferrer">MIT license ↗</a></div><div className="filter-table-wrap"><table><caption>Published preset preamp: {db(profile.preampDb)}. The player can apply a more conservative trim.</caption><thead><tr><th>Band</th><th>Type</th><th>Frequency</th><th>Gain</th><th>Q</th></tr></thead><tbody>{profile.filters.map((filter, i) => <tr key={i}><td>{i + 1}</td><td>{filter.type === 'peaking' ? 'Peak' : filter.type === 'lowshelf' ? 'Low shelf' : 'High shelf'}</td><td>{filter.frequency.toLocaleString()} Hz</td><td>{db(filter.gain)}</td><td>{filter.q.toFixed(2)}</td></tr>)}</tbody></table></div></details>}
  </section>;
});
