# Song EQ validation

Nine six-second controlled broadband multitone passages, 48 kHz, identical phases/envelopes and defined spectral changes. These are synthetic test passages, not commercial recordings or listener preference results. The previous algorithm was preserved before edits in ignored local QA files. Both algorithms use the same PCM; each uses its own analyzer. Responses exclude headphone calibration and shared trim.

## Why the previous algorithm lost differences

Eight averaged bands were reduced to five regions with fixed centers. Time medians/variation were not consumed. A 1.5 dB dead zone, fixed percentage activity gates and ±3 dB hard clamps suppressed or collapsed different deviations. Global level normalization was appropriate; independent spectral detail and robust temporal weighting were missing.

## Old / new response, in dB

| Passage | 125 Hz | 1 kHz | 8 kHz | New reference family | Weighted fit error, dB |
|---|---:|---:|---:|---|---:|
| balanced | +0.00 / -0.16 | +0.00 / +0.01 | +0.00 / +0.90 | Balanced | 0.12 |
| bass-heavy | -0.77 / -3.86 | +1.99 / -0.16 | +2.74 / +0.54 | Bass-rich | 0.25 |
| bass-light | +0.50 / +2.99 | +0.00 / +0.08 | +0.00 / -0.06 | Balanced | 0.20 |
| bright | +0.01 / +0.00 | +0.19 / -0.01 | -0.85 / -1.11 | Bright | 0.20 |
| dark | -0.16 / -0.10 | +0.30 / +0.15 | +2.58 / +3.89 | Dark | 0.16 |
| mid-focused | -0.02 / -0.10 | -0.41 / -1.45 | +1.76 / +2.05 | Mid-focused | 0.19 |
| presence-led | -0.00 / -0.00 | -0.10 / -0.27 | +0.43 / +1.56 | Presence-led | 0.18 |
| peak-700 | -0.00 / -0.14 | -0.04 / -0.96 | +0.83 / +1.01 | Mid-focused | 0.19 |
| peak-1800 | +0.00 / -0.02 | +0.00 / -0.26 | +0.56 / +1.60 | Presence-led | 0.13 |

## Checks

65 Node tests pass, including opposing bass/treble response directions, midrange vs presence emphasis, shifted local peaks, deterministic output, level invariance, small-perturbation stability, a loud 60 ms treble burst, sparse-tone fallback, broad filter constraints, calibration identity, and the full ±5 dB song bound through 150% strength. Fitting error stays below 0.7 dB on these fixtures; no minimum gain or artificial variation is imposed.

20 native browser DSP checks pass at 44.1/48 kHz. Actual rendered combined EQ matches its graph; zero blend is sample-identical to measured correction; shared -1 dBFS sample peaks and scheduled crossfades remain bounded on the hot test fixture. These establish implementation behavior, not acoustic optimality or listener preference.

Raw local results: .local-tests/robust-song-comparison.json and .local-tests/robust-song-native-report.txt. Reproduce the public test cases with pnpm test and tests/browser-adaptive.html. Native headphone listening and diverse real music remain the next evaluation step.
