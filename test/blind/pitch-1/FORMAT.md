# Blind pitch set — file formats

## Audio
- 404 WAV files, mono, 1.5–5.1 s. Four encodings, rotated across groups: 48 kHz float32 (119), 44.1 kHz 16-bit
  PCM (117), 48 kHz 16-bit PCM (91), 44.1 kHz float32 (77). Float files are WAVE_FORMAT_IEEE_FLOAT (format 3) with
  a `fact` chunk; 16-bit files are PCM with TPDF dither (except the two "digital_zero" files, which are exact zeros).
- Peak ≤ −1 dBFS (a file is scaled down as a whole if needed; `gain_applied_db` in the truth records it).
- Name: `NNN_<group>_<description>_<48k|44k1>_<f32|pcm16>.wav`. The description is for humans; the scorer only uses
  `truth.json`.

## commands.tsv
One line per WAV: `file<TAB>engine options`. Options are exactly the flags of `scripts/tuner-json.mjs`:
`--a4 <Hz> --tolerance 3`, plus `--targets <MIDI,...>` (instrument mode, strings low → high as played) and
`--locked <i>` (0-based index into `--targets`) where the file is meant for instrument / locked-string mode.
No `--targets` = chromatic mode. `run_engine.sh` feeds these lines to the engine.

## truth.json
`{ version: 1, created, generator, tolerance_cents, files: [File] }`

File:
| field | meaning |
|---|---|
| `file`, `group`, `tags`, `instrument` | name, scoring group, tags (`A4-safety`, `A5-decay`, `phone-mic-hp100`), human description |
| `sampleRate`, `format` (`float32`/`pcm16`), `channels` (1), `duration_s` | |
| `a4`, `mode` (`chromatic`/`auto`/`locked`), `targets`, `locked`, `tolerance_cents`, `args` | the engine run settings (same as commands.tsv) |
| `background` | noise / hum / click layers with levels, `bg_rms_dbfs`, `highpass` `[fc, order]` (phone-mic model), `clip` |
| `sources` | every synthesized note with its full parameters (model, first-partial Hz `F1`, onset, level, inharmonicity `B`, T60, vibrato/bend/glide, partial table). `primary: false` = interferer (12-string partner, sympathetic string) |
| `segments` | contiguous time segments `[t0, t1)` covering the whole file (below) |

Segment, all kinds: `t0`, `t1` (seconds of signal time), `expect`:
- `reading` — a note is sounding clearly; a correct tuner must show it.
- `nothing` — no reading may be shown (silence, pre-roll before the first note). Status `noisy` here is also wrong.
- `nothing_or_noisy` — background only (noise, hum, clicks): no reading; `noisy` ("Too noisy") is allowed but never
  required (with SPEC §5.4's 3-s percentile floor, stationary noise never meets the `noisy` condition).
- `dont_care` — the decaying tail of a note (or the 1.5 s hold after a sustained note): nothing is required; shown
  readings are still checked for the right note (`tail` columns). `truth_of` = index of the note's segment.
- `grace_s` (nothing segments) — frames in `[t0, t0 + grace_s)` are reported separately, not as false readings
  (2.2 s on hum: SPEC's hum rule needs ≥ 2 s to classify; 0 elsewhere).

Reading segment fields:
| field | meaning |
|---|---|
| `hz` | true pitch = first-partial frequency (for inharmonic plucks `f0·sqrt(1+B)`; for a missing fundamental the period frequency) |
| `hz_curve` | only when `modulated`: `[[t, hz], …]` every 5 ms (vibrato, bend, pitch glide) |
| `midi`, `note`, `cents` | nearest equal-tempered note at the file's `a4`; cents in [−50, +50) |
| `target_midi`, `target_index`, `cents_vs_target` | expected target string (locked string, nearest string in auto mode, nearest note in chromatic mode); `null` if two strings are equally near |
| `expected_status` | allowed statuses after settling, from SPEC §5.4: > +300 c `muchTooHigh`, < −700 c `veryLow`, beyond ±(tol+1) `sharp`/`flat`, within ±(tol−1) `inTune`, in between either. `null` for modulated notes |
| `onset` | true = a new note starts at `t0` (settle and latency are measured from here) |
| `settle_budget_ms` | SPEC A5: 150 (plucks 82–1000 Hz), 300 (< 70 Hz), `null` = not judged (other ranges, bowed/wind/synth attacks) |
| `eval_from` | accuracy frames start here: onset + attack + 150 ms (300 ms below 70 Hz) |
| `a2_bucket` | `core` (harmonic 40–1000 Hz, SNR ≥ 20), `high` (1000–2100 Hz), `low30_40`, `inharmonic` (plucks B ≤ 5e-4), `inharmonic_strong` (B > 5e-4), or `null` (modulated, clicks, clipped, SNR < 20, octave-ambiguous, < 27.5 Hz) |
| `a3_bucket` | `snr20plus`, `snr10`, or `null` |
| `snr_db` | note RMS over the first 0.3 s after its attack ÷ background (noise + hum) RMS; `null` = no background |
| `modulated`, `octave_ambiguous`, `steady` | `octave_ambiguous`: the note or its octave is accepted (cents compared modulo 1200); `steady`: constant pitch and level (A5 display-stability check) |
| `prev_hz` | the previous note in a string change (direction check accepts either note during the first 0.3 s) |
| `inharmonicity_B`, `model` | |

A reading segment ends (and a `dont_care` tail begins) at the earliest of: the next onset, the end of a sustained
note, onset + 2.4 s (4.5 s in `sustain-long`), the first 20 ms block where the note is below −50 dBFS (−62 dBFS for
the `quiet` group), or — for plucks over a background — where its local SNR has fallen 6 dB below `snr_db`.

## Engine output (input of check.py)
As printed by `scripts/tuner-json.mjs` (per its header): one JSON object per file,
`{ file, sampleRate, frames: [{ t, hz, noteMidi, targetMidi, stringIndex, cents, displayCents, status, stable, held }] }`.
`check.py` accepts a folder of `*.json`/`*.jsonl`/`*.ndjson`/`*.txt` files, each holding one or more such objects
(concatenated, one per line, or in an array), and matches them to the truth by the base name of `file`.
Assumptions (adjust with options if the engine differs):
- `t` = signal time in seconds of the newest sample of the analysed window (ms is auto-detected); `--t-offset`
  shifts it.
- A frame **shows a reading** when `status` ∈ {`flat`, `sharp`, `inTune`, `muchTooHigh`, `veryLow`} and `held` is
  false. `idle`, `listening`, `noisy` and held (greyed) frames show no reading.
- `hz` is the frequency the engine measured for that frame; `noteMidi` its nearest note (if absent, derived from
  `hz`); `targetMidi` the string/note it is tuning against; `displayCents` the integer on screen.
