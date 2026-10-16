# Real-recording blind set (O1, "real recordings") — tuner engine

Written 2026-10-16 by a separate oracle agent for SPEC §13.2 (O1, real recordings) next to the synthetic set
`tn-blind-1`. Independence: this agent read only `docs/SPEC.md`, the first 40 lines of `scripts/tuner-json.mjs`
(output format and flags) and the synthetic set's `FORMAT.md` / `check.py`; it never read `src/` or `test/`. The
ground truth is this agent's own measurement of each recording (method below), cross-checked against the note name
in the Iowa catalogue. The analysis tools are kept outside this folder (see "Rebuilding").

Protocol (SPEC §13.2): commit the engine snapshot first, copy this folder in, run it **once**, record the numbers.
SPEC: real-recording results are **reported separately, with their reference uncertainty, and never mixed into the
synthetic A2 cents figure**. `check.py` therefore prints no PASS/FAIL for accuracy, only the measured numbers next
to the A1 limits as a yardstick (A4 safety and wrong-direction checks keep their PASS/FAIL).

## Licence / source
University of Iowa Electronic Music Studios, Musical Instrument Samples (MIS), https://theremin.music.uiowa.edu/MIS.html,
by Lawrence Fritts. Terms as stated on that page (read 2026-10-16): the recordings "may be downloaded and used for
any projects, without restrictions"; the page asks to be told when they helped a project. No other licence text was
found. Download approved by the owner on 2026-10-16 11:55 ("a few hundred MB at most").

Downloaded: 124 HTTP requests, **392 MB** (55 of them byte ranges: piano notes and the long 24/96 guitar files were
fetched only as far as needed) plus 25 HTML catalogue pages (0.8 MB), all into `dl/` (untrusted data: nothing there
is ever executed; `dl/downloads.tsv` lists time, status, bytes, byte range, SHA-256 and URL of every request).
`dl/probe/` (three 64 KB header probes) and `dl/cello2014/` (one 2014-set file used to compare the two Iowa sets)
are not used in the set. All excerpts come from the **pre-2012** Iowa set (16-bit/44.1 kHz mono chromatic scales;
piano: single notes, stereo; guitar: 24-bit/96 kHz mono scales). Recording rooms per Iowa: an anechoic chamber,
except the piano (and, judging by its noise, the guitar).

## Contents
- **Main set: 215 WAV files = 176 distinct recordings** (+ 39 variants: the same audio run in another engine mode),
  mono 44.1 kHz, 3.2–5.0 s, 17.0 min. Every note passed the catalogue check (|own estimate − catalogue note| ≤ 5 c
  at A4 = 440).
- `truth.json`, `commands.tsv`, `run_engine.sh`, `check.py` — same roles and formats as in the synthetic set
  (differences: `FORMAT.md`, marked REAL). `discards.json` — every analysed note that is not in the main set and why.
  `MANIFEST.sha256` — checksums of every file outside `dl/`.
- **`supplement/` (optional, NOT part of the main set): 361 files = 306 distinct recordings** whose own estimate is
  5–50 c away from the catalogue note — i.e. they FAILED the 5-cent catalogue check you asked for. They are kept
  apart because otherwise there would be no guitar at all: the whole Iowa guitar session is tuned 16–44 c flat
  (A4 ≈ 430). Their truth is the same measurement; their note identity is confirmed by the catalogue position, but
  the cents are not confirmed by the catalogue. Use them only as extra, clearly separated evidence (flat/sharp
  readings, guitar, 96 kHz input), never pooled with the main numbers.

### Main set per instrument
| group | files | distinct recordings | range (Hz) | dynamics | vibrato/modulated | modes |
|---|---|---|---|---|---|---|
| dbass-arco | 44 | 34 | E1–A#3 (41.2–233.4) | ff 12, mf 17, pp 5 | 12 | auto 19, chromatic 15, locked 10 |
| dbass-pizz | 15 | 14 | G1–G3 (48.9–195.9) | ff 1, mf 13 | 2 | auto 4, chromatic 10, locked 1 |
| cello-arco | 14 | 10 | C#2–F4 (69.5–348.1) | mf 10 | 0 | auto 7, chromatic 3, locked 4 |
| cello-pizz | 7 | 4 | C2–B3 (65.3–246.8) | mf 4 | 0 | auto 3, chromatic 1, locked 3 |
| viola-arco | 29 | 22 | C3–G#5 (130.6–830.9) | ff 6, mf 16 | 0 | auto 9, chromatic 13, locked 7 |
| violin-arco | 5 | 4 | G#4–B5 (416.0–990.8) | mf 4 | 0 | auto 2, chromatic 2, locked 1 |
| violin-pizz | 4 | 2 | A4–E5 (439.9–657.7) | mf 2 | 0 | auto 2, locked 2 |
| flute-novib | 4 | 4 | F4–D#5 (348.5–623.9) | mf 4 | 0 | chromatic 4 |
| flute-vib | 6 | 6 | D#5–A5 (621.9–881.3) | mf 6 | 6 | chromatic 6 |
| clarinet | 22 | 22 | F3–D6 (174.2–1175.2) | ff 7, mf 15 | 0 | chromatic 22 |
| oboe | 13 | 13 | D#4–F6 (310.5–1399.3) | ff 3, mf 10 | 0 | chromatic 13 |
| trumpet-novib | 7 | 7 | F3–B5 (174.5–986.4) | mf 7 | 0 | chromatic 7 |
| trumpet-vib | 4 | 4 | C#4–B4 (276.8–494.0) | mf 4 | 4 | chromatic 4 |
| piano | 30 | 30 | A1–D5 (54.9–588.3) | ff 2, mf 28 | 0 | chromatic 30 |
| harmonic | 11 | (variants) | A2–G4 (109.7–391.8) | - | 0 | locked 11 |
| **total** | **215** | **176** | | | | |

"harmonic" = harmonic-test variants: the string is LOCKED and the played note is 2× or 3× its frequency (A2 on a
locked A1, B2 on E1, D3 on D2, E3 on A1, G3 on G2, G4 on G3); the engine should say `harmonic` (or `muchTooHigh`)
and never "tighten". Variants also include `locked` runs of every open-string note (the same audio as its `auto`
run). Range E1–E6: the main set spans E1 (41.2 Hz, double bass) to F6 (1399 Hz, oboe); E6 itself and the guitar are
only in the supplement (piano E1/E6 are stretch-tuned −14/+11 c and fail the 5-c check; the guitar fails it on
every note). Nothing below 40 Hz exists in the selected material (no `low_below_40` bucket).

### Supplement per instrument
| group | files | distinct recordings | range (Hz) | dynamics | vibrato/modulated | modes |
|---|---|---|---|---|---|---|
| dbass-arco | 35 | 32 | G1–B3 (48.7–244.8) | ff 12, mf 18, pp 2 | 10 | auto 10, chromatic 22, locked 3 |
| dbass-pizz | 17 | 13 | E1–F#3 (40.8–184.0) | ff 2, mf 11 | 2 | auto 6, chromatic 7, locked 4 |
| cello-arco | 21 | 19 | C2–G4 (65.6–394.8) | ff 3, mf 16 | 1 | auto 6, chromatic 13, locked 2 |
| cello-pizz | 29 | 26 | C#2–G4 (67.9–395.2) | ff 7, mf 19 | 2 | auto 10, chromatic 16, locked 3 |
| viola-arco | 38 | 36 | C#3–B5 (137.2–997.2) | ff 11, mf 25 | 0 | auto 12, chromatic 24, locked 2 |
| violin-arco | 26 | 22 | G3–C#6 (195.3–1140.3) | ff 2, mf 20 | 2 | auto 8, chromatic 14, locked 4 |
| violin-pizz | 9 | 7 | G3–G4 (194.1–399.8) | mf 7 | 2 | auto 2, chromatic 5, locked 2 |
| guitar | 24 | 17 | E2–G4 (80.4–387.5) | ff 1, mf 16 | 0 | auto 12, chromatic 5, locked 7 |
| flute-novib | 28 | 28 | C4–B6 (259.9–1996.8) | mf 28 | 1 | chromatic 28 |
| flute-vib | 5 | 5 | C5–A#5 (527.3–939.3) | mf 5 | 5 | chromatic 5 |
| clarinet | 24 | 24 | D3–B6 (146.1–1945.2) | ff 11, mf 13 | 3 | chromatic 24 |
| oboe | 24 | 24 | A#3–G6 (234.8–1558.2) | ff 7, mf 16, pp 1 | 0 | chromatic 24 |
| trumpet-novib | 25 | 25 | E3–A5 (165.9–874.7) | mf 25 | 1 | chromatic 25 |
| trumpet-vib | 8 | 8 | C4–A4 (260.6–437.7) | mf 8 | 8 | chromatic 8 |
| tuba | 11 | 11 | C2–A#2 (66.2–118.1) | mf 11 | 0 | chromatic 11 |
| piano | 9 | 9 | E1–E6 (40.9–1326.5) | ff 1, mf 8 | 0 | chromatic 9 |
| harmonic | 28 | (variants) | E2–A5 (82.0–887.0) | - | 0 | locked 28 |
| **total** | **361** | **306** | | | | |

### What was analysed and why notes were dropped (767 notes from 120 source files)
- 176 → main set; 306 → supplement (5–50 c from the catalogue note; median offsets per group: guitar −23 c,
  tuba +18 c, cello pizz −16 c, violin −9 c, flute (no vibrato) +9 c, trumpet −6 c; the Iowa players' intonation,
  plus the flat guitar tuning).
- 285 dropped (`discards.json`): 174 notes whose catalogue name could not be assigned (the source file holds more
  or fewer notes than its name says — extra takes, repeated notes, noise bursts in the guitar files — and the note
  does not line up; see below), 16 where our estimate is > 50 c from the catalogue note (octave or note mismatch;
  e.g. piano ff E1 measured as E2: weak fundamental), 57 with too little usable truth after the attack (< 30
  frames or < 0.3 s), 11 with no usable truth frames at all (very short pizzicato), 27 with less than 2 s before the
  next note (excerpt too short).

## How the truth was established (own measurement; the catalogue is only a cross-check)
1. AIFF → WAV with an own Python-standard-library reader (no ffmpeg on this Mac). Mono 16/24-bit sources are copied
   bit-exactly; stereo (piano) = (L+R)/2 as float32. Original sample rate kept.
2. Notes are found in each chromatic-scale file from a 10 ms RMS envelope (a rise ≥ 20 dB over the previous 0.3 s
   minimum, sustained ≥ 0.25 s, peak within 18 dB of the file's median note peak); the onset is walked back to where
   the rise began and refined to the first sample reaching 10 % of the early peak.
3. **Catalogue-blind coarse pitch** per note: weighted subharmonic summation over 25–2500 Hz (1-cent grid) on a long
   Hann window, with an octave check, then progressive partial tracking (partials 1–2 searched ±4 %, every further
   partial predicted from the running f0/inharmonicity fit, ±0.6 %).
4. **Truth curve (method A, first partial)**: every 10 ms a Hann-windowed FFT (window max(0.12 s, 12 periods), 8×
   zero padding; on vibrato notes a second pass with max(0.05 s, 6 periods)), partial peaks k = 1…8 (plucked/piano)
   or 1…12 (bowed/wind) located with log-parabolic interpolation and ≥ 12 dB above the local spectral floor; the
   first-partial frequency is a weighted fit (inharmonicity B fixed per note from a whole-note fit for pizzicato and
   piano, B = 0 for bowed/wind). The SPEC defines the truth of an inharmonic tone as its first partial; that is `hz`
   and `hz_curve`.
5. **Second reference (engine-like period)**: every 10 ms a single-period NSDF on a 4096/8192-sample window ending at
   t (`hz_curve_period`). It agrees with method A to 0.07 c median / 0.4 c p95 on bowed and wind notes; on
   pizzicato the two differ by 0.2 c median / 4 c p95, on piano by 6 c median / 19 c p95, the period always being
   the higher (the stiff-string partials above the first one are sharp, and a period detector follows them). `check.py --vs period` scores against it.
6. **Catalogue cross-check**: the catalogue note of each excerpt is its position in the scale named by the file
   (`assignment: position`, 136 main notes) or, when the file holds a different number of notes than its name says,
   a monotonic alignment in which a note takes the next catalogue name only if our estimate rounds to it, repeats
   and strays being dropped (`aligned`, 40 main notes; for these the note NAME check is partly circular, the 5-c
   check is not). Main set = |median of the truth curve over the evaluation span − catalogue note at A4 = 440| ≤ 5 c
   (median 2.7 c, max 4.97 c).
7. **Validation of the estimator** on more than 100 files of the synthetic set `tn-blind-1` (truth known exactly):
   note frequency within 0.005 c and frame p95 within 0.05 c on clean steady harmonic, bowed, wind and inharmonic
   plucked tones from 31 Hz to 2.1 kHz (B up to 1.5e-3; first partial), 0.3 c at 20 dB SNR; vibrato curves within
   0.2–0.35 c median / 0.3–0.6 c p95 at ≥ 98 Hz, 0.6–1.3 c / 1.0–1.9 c at 55–73 Hz. Known failures (no such signals
   are in this set): F♯0 23 Hz (octave), 12-string octave pairs, hum under a note, E1 with ±10 c vibrato (5 c).
   A separate full-range MPM spot check on 54 frames of bowed/wind notes of the finished main set agrees with the
   local truth within 0.12 c median / 0.7 c p90 (max 1.7 c).

### Reference uncertainty (`ref.ref_u_cents`, printed by check.py as "ref_u")
Per note: √(0.05² + |A − B|² (bowed/wind only; B = a multi-period time-domain check of method A) + (pitch slope ×
20 ms)² + 0.5² (vibrato notes)). Median 0.23 c, p90 0.43 c on steady bowed/wind notes; 0.08 c on pizzicato/piano
(their real uncertainty is the first-partial-vs-period definition above, printed separately as "period-vs-first-
partial gap"); 1.3 c median / 4.8 c p90 on vibrato notes. **These recordings drift**: the median pitch spread inside
one note's evaluation span is 8 c (bowed/wind), so an engine frame is scored against the truth curve averaged over
the engine's own window (ASSUMPTION, below), not against one number per note; `--vs median` shows the difference.

## Assumptions (marked here; the scoring ones can be changed with check.py options)
- ASSUMPTION: the engine reads A4 = 440 and tolerance 3 c; real players were tuned close to 440 (main set: by construction).
- ASSUMPTION (window): the pitch an engine reports at frame time t is the mean pitch over its analysis window
  [t − W, t], W = 4096 samples (8192 when the note or the instrument's lowest string is < 70 Hz; doubled at
  ≥ 88.2 kHz) per SPEC §5.3 step 1. Override with `--window S`. On pizzicato attacks this choice alone moves the
  error by up to ~6 c in the first 0.2 s.
- ASSUMPTION: `t` in the engine output is the newest sample of the window (tuner-json header says so); `--t-offset`.
- ASSUMPTION: vibrato notes use the synthetic rule (a reading is right if it lies within the truth range of the last
  `--lookback` 0.2 s).
- ASSUMPTION: status `harmonic` shows a reading; on harmonic-test files `harmonic` and `muchTooHigh` are both
  right; in auto mode a `harmonic` frame is the right target when it names a string of which the note is a 2nd/3rd/
  4th partial (`alt_target_midis`).
- ASSUMPTION: expected statuses use the note's own measured pitch spread ± 1 c, SPEC §5.4 thresholds (> +300 c
  `muchTooHigh`, < −700 c `veryLow`, beyond ±4 c `sharp`/`flat`, within ±2 c `inTune`, 2–4 c either).
- ASSUMPTION: auto mode is used only for notes within ±1 semitone of a string of the instrument's standard tuning
  (double bass E1 A1 D2 G2, cello C2 G2 D3 A3, viola C3 G3 D4 A4, violin G3 D4 A4 E5, guitar E2…E4); everything
  else runs chromatic. Expected target = the nearest string.
- ASSUMPTION: reading segments end where the truth stops being measurable or the level falls below
  max(−60, min(−50, peak − 30)) dBFS, at the latest 2.4 s (plucked) / 4.4 s (sustained) after the onset; after
  that `dont_care` until the note has died away + 1.5 s hold, then `nothing`.
- ASSUMPTION: where less than 0.5 s of quiet source audio precedes an onset, the excerpt is padded with digital
  zeros (58 main files) — the engine meets an abrupt start from silence there.

## How to run
```sh
sh run_engine.sh <app repo folder> <output folder>                 # 215 node runs, one JSON per WAV
python3 check.py <output folder>                                   # report on stdout
python3 check.py <output folder> --json report.json                # + machine-readable report
python3 check.py <output folder> --vs period                       # same, against the engine-like period truth
python3 check.py <output folder> --vs median                       # same, one frequency per note
python3 check.py <output folder> --file 021_                       # frame-by-frame view of one file
shasum -a 256 -c MANIFEST.sha256                                   # set unchanged?
# optional supplement (kept apart; never pool it with the main numbers):
sh run_engine.sh <app repo folder> <output folder 2> supplement
python3 check.py <output folder 2> --set supplement
```
Other options as in the synthetic scorer: `--t-offset S`, `--lookback S`, `--group G`, `--window S`, `--all`.
The scorer was self-tested with ideal outputs written from the truth itself (0.00 c errors, 100 % right notes, no
false readings) and with 0.5 c Gaussian noise (p95 0.98 c, as expected).

## What check.py measures
All columns of the synthetic scorer per group and per bucket (`R:steady_harmonic`, `R:pluck_first_partial`,
`R:piano_first_partial`, `R:high_1000_2100`, `R:vibrato`, `R:all-base`, `A3:snr20plus`): cents error of shown
frames (median / p95 / max) next to the reference uncertainty and the period-vs-first-partial gap, coverage,
right note (octave included), target string, status in the expected set, harmonic errors, false readings on
silence, wrong direction, settle time (budgets only on pizzicato/piano), display stability on `steady` notes. The
closing block prints: accuracy per bucket (reported, with the A1 limits as a yardstick), A3-like right-note rate,
silence, harmonic-test results (share of `harmonic`/`muchTooHigh`), A4 safety (PASS/FAIL), SPEC §9 guard, wrong
direction, settle, octave errors, steady display.

## Rebuilding
The builder (own Node/Python scripts, no dependencies) lives outside this folder in
`../tn-blind-real-build/tools/` with its intermediate files in `../tn-blind-real-build/work/` (they read `dl/` via a
symlink there): `aiff2wav.py` → `analyze.mjs` (per source scale) → `build.mjs` → `period.mjs`. Sources and dynamics:
`../tn-blind-real-build/tools/sources.tsv`.
