# AdaptiveEQ build plan

Status: Steps 2 through 5 implemented in `adaptive-eq/`: player, pinned Arctis 7+ correction, background original-track analysis, and experimental track-dependent EQ. Adaptive mode includes a strength control, measured/adaptive/applied graph, numerical explanations, a combined 2 dB curve-change bound, verified sample peaks, and shared trim across all three modes. Production build and 52 Node tests pass; 17 new native adaptive checks passed alongside the earlier 8 worker and 20 measured DSP checks. Major V remains unsupported. Physical listening is still a user check. Step 6, a loudness-matched randomized listening comparison, is next.

Constraints: 11 hours remaining, one developer, Windows. Available headphones: Marshall Major V and an Arctis 7+ (assumed to mean SteelSeries Arctis 7+; confirm the label before importing its profile).

## Product and scope

The demo lets someone choose their headphones, load a local song, and hear a proposed correction informed by both the headphone profile and the recording's frequency content. It explains the measurements behind the recommendation and offers a fair comparison.

Build a local browser application for desktop Chrome or Edge. Keep audio processing on the user's computer. Support local WAV/MP3 files, one verified headphone profile initially, and one static EQ setting per track.

Use the Arctis 7+ for the first measured demo: an exact model is listed in [AutoEq's RTINGS results](https://github.com/jaakkopasanen/AutoEq/blob/master/results/Rtings/README.md). Before importing, check the actual profile, measurement conditions, target, and applicable reuse terms; preserve attribution. Test with additional vendor EQ, spatial processing, and Windows enhancements disabled by the user.

Marshall Major V support is optional. A [SoundGuys measurement review](https://www.soundguys.com/marshall-major-v-review-116141/) exists, but a ready-to-use numerical correction profile has not been confirmed. Spend at most 15 minutes looking for a suitable exact-model profile. Otherwise label the model unsupported. Do not substitute a different Major generation's profile.

Defer accounts, a backend, streaming-service integration, system-wide audio, continuous adaptation during a song, automatic device identification, model training, speaker calibration, and learning user preferences. Hosting is a separate decision after the local demo works.

## Proposed implementation

| Part | Choice |
| --- | --- |
| App | React + TypeScript with [Vite](https://vite.dev/guide/) |
| Playback and filters | Web Audio API, with one shared audio engine |
| Analysis | Meyda power-spectrum extraction over decoded audio, in a worker |
| Headphone data | Bundled, attributed JSON converted from a verified AutoEq profile |
| EQ graph | SVG displaying the actual combined filter response |
| Comparison | Short offline-rendered excerpts, matched in loudness |
| Persistence | Local settings and optional downloadable test results |

[Meyda](https://meyda.js.org/audio-features) supplies FFT-derived features. [BiquadFilterNode.getFrequencyResponse](https://developer.mozilla.org/en-US/docs/Web/API/BiquadFilterNode/getFrequencyResponse) supplies the response of the actual filters. [OfflineAudioContext](https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext) can render filtered audio into a buffer for analysis and comparison.

Keep the code in four small areas: player/audio engine, track analysis, profile/adaptation calculations, and UI. Store model name, source, target, connection/mode information when available, attribution, filter parameters, and profile preamp with each headphone profile.

## Steps and time budget

These are target allocations from the start of implementation. Review each step before proceeding; reduce scope when an allocation runs out. Preserve the final two hours for testing and presentation.

| Step | Budget | Cumulative time | Visible checkpoint |
| --- | --- | --- | --- |
| 1. Confirm demo scope and data | 30 min | 0:30 | Exact first headphone, usable profile, two local demo tracks |
| 2. Build playback | 90 min | 2:00 | Load, play, pause, seek, and change files |
| 3. Apply measured headphone EQ | 60 min | 3:00 | Working original/corrected modes and a real response graph |
| 4. Analyze the song | 90 min | 4:30 | Stable frequency-content summary with progress feedback |
| 5. Add experimental track adaptation | 90 min | 6:00 | Deterministic track-dependent correction and explanations |
| 6. Build a fair listening comparison | 90 min | 7:30 | Loudness-matched, randomized baseline/adaptive comparison |
| 7. Polish the complete flow | 90 min | 9:00 | Coherent UI, error handling, verified production build |
| 8. Test and rehearse | 120 min | 11:00 | Reliable demo, recorded observations, backup assets |

### Step 1: Confirm demo scope and data

- Confirm the headset's exact model and connection mode.
- Inspect the matching numerical EQ profile and its provenance.
- Choose two local audio files with contrasting frequency content, suitable for use in the demo.
- Choose a consistent default reference from the imported profile.
- Define the core interaction: load song -> select model -> analyze -> play -> compare.

Done when the first physical headphone, its profile, and the demo files are ready. A second headphone is an extension, not a requirement for starting.

### Step 2: Build playback

- Set up the app and a single audio engine outside React's render lifecycle.
- Decode local files, show metadata/duration, and implement play, pause, seek, and volume.
- Start/resume audio after a user gesture.
- Show useful errors for unsupported, corrupt, or excessively large files. Start with a five-minute track limit and a conservative file-size limit.
- Clean up previous playback and invalidate outstanding analysis when a new file is loaded.

Done when both demo files play reliably and repeated track changes do not duplicate audio or leave stale state.

### Step 3: Apply measured headphone EQ

- Import the profile's frequency, Q, gain, filter types, and preamp.
- Implement two explicit modes: Original and Headphone correction.
- Plot the combined response calculated from the actual filter chain at the active sample rate.
- Reserve headroom based on the combined response and imported preamp; check processed audio peaks. A frequency-response estimate alone is not proof that a particular waveform cannot overshoot.
- Use brief gain ramps for mode/profile changes to avoid clicks. Keep a working bypass available.

Done when playback reflects the imported settings, the graph matches the applied chain, and the demo tracks have checked headroom. This is the working baseline to retain throughout later steps.

### Step 4: Analyze the song

- Analyze decoded audio before EQ, across the recording rather than only its introduction.
- Start with Hann-windowed FFT frames and aggregate powers into about eight broad frequency regions. Use a sufficiently long FFT for useful bass resolution; begin with 8192 samples and 50% overlap.
- Combine left/right channel powers rather than summing their waveforms, which could cancel out-of-phase content.
- Exclude silence, calculate relative band energies, and summarize how consistently regions contain content.
- Normalize the features so changing only the source gain does not change the proposed tonal correction.
- Show analysis progress and retain one analysis result per loaded track.

Done when bass-focused and treble-focused fixtures produce the expected summaries, silence is handled cleanly, and the same recording at two levels produces equivalent relative features.

The UI should say "substantial energy in this region," rather than claiming to have identified important vocals or instruments.

### Step 5: Add experimental track adaptation

Use a simple, bounded hypothesis that fits the deadline: retain more of the measured correction where the recording contains substantial content, and slightly reduce correction in sparsely occupied regions.

For each imported filter:

1. Derive a relevance score `r_i` between 0 and 1 from the track's broad-band relative energy and occupancy around the filter's effective frequency region. Handle shelves using their affected range, not only their turnover frequency.
2. Start with `strength_i = 0.7 + 0.3 * r_i`.
3. Scale the baseline gain toward zero using this strength. Preserve filter frequency and Q. Do not increase the magnitude of any individual filter gain beyond the measured-profile baseline.
4. Limit the departure of the complete combined response from measured EQ to 2 dB on a 4,098-point grid including DC/Nyquist. Reduce the overall adaptation amount if needed. Re-render track peaks before installing the new setting; retain verified playback while checking. All modes share conservative trim.
5. Keep the result fixed for the track. Add an adaptation-strength control that returns exactly to the baseline at zero.

The numerical choices above are experimental defaults, not validated acoustic thresholds. This is a content-relevance heuristic, not a model of perception, masking, musical importance, or a device's distortion/output limits. It may undercorrect a headphone, and it may offer little advantage over the static profile. Step 6 tests that hypothesis.

Implemented policy: band relevance is `0.5 * sqrt(energy / largest_band_energy) + 0.5 * activity_fraction`, clamped to 0–1. Filter relevance averages band relevance using its actual absolute dB response on the log-frequency grid. Strength `s` gives `gain_i = baseline_i * (1 - 0.3 * (1 - r_i) * s)`, followed by the combined-response bound. Zero uses the measured branch exactly. Missing/silent analysis, clips under 3 seconds, or fewer than 16 analyzed frames use measured correction. Strength changes commit on slider release/keyboard interaction; obsolete results cannot apply. Shared trim can stay more conservative after reducing adaptation, preserving a stable, safe comparison while settings fade.

Do not add more bass simply because a song is bass-heavy. A frequency-response profile does not establish that the headphone can deliver an extra boost without distortion.

Generate explanations directly from the measured profile and calculated decisions. For example: "This region has substantial content in this track, so we retained most of the profile's correction here." Show actual values only after calculating them.

Done when different relevant inputs can produce different bounded settings, repeated analysis is deterministic, and adaptation strength zero exactly reproduces the baseline. Similar tracks may legitimately receive similar settings.

### Step 6: Build a fair listening comparison

- Keep three modes: Original, Headphone correction, and Adaptive correction.
- For blind preference trials, compare Headphone correction against Adaptive correction on the same 20-30 second excerpt using the matching physical headset.
- Render the variants with identical timing. Measure integrated loudness with a tested BS.1770 implementation, then lower them to a common attainable loudness. Check output peaks again after matching and lower both further if needed.
- Use a [BS.1770-based meter](https://www.itu.int/rec/R-REC-BS.1770-5-202311-I/en); RMS and Meyda's loudness feature are not substitutes for this measurement.
- Randomize A/B labels. Allow A, B, or No preference; reveal the assignment after voting. Record track, excerpt, profile, algorithm version, choice, and loudness difference.
- Avoid audible switching artifacts. Hide mode-specific graphs and explanations during blind trials.

Done when both variants play the same passage, loudness matching has been checked, and labels do not reveal the active processing. If a trustworthy meter cannot be integrated within this allocation, prepare and verify matched demo excerpts with a trusted offline tool and keep the test restricted to those excerpts. Do not label an arbitrary RMS-matched comparison as LUFS-matched.

### Step 7: Polish the complete flow

- Build one clear screen: file input, headphone selector, analysis state, player, mode controls, EQ graph, and two or three measured explanations.
- Include empty, analyzing, ready, unsupported-profile, and failure states.
- Make the active profile and processing mode unmistakable.
- Keep the analysis summary separate from the EQ response: the song spectrum and applied correction describe different things.
- Verify a production build and the complete workflow in the chosen browser.

Done when a new user can load a file, understand the recommendation, and run a comparison without developer help.

### Step 8: Test and rehearse

- Run focused checks for band-energy normalization, silence handling, adaptive gain limits, exact baseline restoration, and rendered output headroom.
- Manually exercise file changes, seek/pause/resume, repeated mode changes, unsupported files, and the full blind-test flow.
- Listen on the matching Arctis 7+ with additional processing disabled. Use the Major V only with an appropriate profile, or clearly as an unsupported-device playback example.
- Collect a few randomized preferences if other listeners are available. Treat this as exploratory feedback, not proof of broad superiority.
- Prepare a short pitch and two dependable demo passages. Keep a local build and backup screenshots or a recording available.

Success means the software works, its recommendations are traceable to actual inputs, and its limitations are accurately described. A listening result favoring the static baseline is valid evidence; do not force larger changes to manufacture a win.

## Deadline rules

- At hour 3, preserve a functioning player with measured headphone correction.
- At hour 6, freeze the adaptive formula and move to comparison and reliability.
- At hour 9, freeze features. Use the remaining time for defects, listening, and rehearsal.
- Drop the second headphone, saved preferences, extra visualizations, and hosting before dropping core playback or comparison reliability.
- If adaptive processing is unstable, retain the working baseline and the track/device explanations, and describe adaptation as incomplete. This is a fallback deliverable, not completion of the full adaptive goal.

## First item to review together

Step 1 proposal: local browser prototype; exact Arctis 7+ profile first; two contrasting local tracks; static per-track processing; Major V support only if suitable data is quickly available. The first implementation milestone is reliable playback, followed by measured headphone correction.
