# Real-recording blind set — file formats

Same layout and engine-output format as the synthetic set (`tn-blind-1/FORMAT.md`); everything that differs is
marked **REAL**.

## Audio
- Main set: 215 WAV files, mono, 44.1 kHz, 3.2–5.0 s (17.0 min). 185 are 16-bit PCM whose samples are copied
  bit-exactly from the mono 16/44.1 Iowa AIFF files; 30 (piano) are 32-bit float (WAVE_FORMAT_IEEE_FLOAT, `fact`
  chunk), because the piano originals are stereo and were averaged to mono as (L+R)/2. No gain, no resampling, no
  dither, no filtering.
- Supplement (`supplement/`): 361 files, same encodings plus 28 guitar files at 96 kHz 24-bit PCM (the guitar
  originals are 24/96 mono; kept at their original rate).
- Every file = 0.5 s before the note onset + up to 4.5 s after it (shorter only when the next note of the source
  scale follows sooner, never under 2 s after the onset). Before the onset: the source's own room noise, or digital
  zeros where the source has less than 0.5 s of quiet room noise there (tag `preroll-zero-pad`, 58 main files).
- Name: `NNN_<group>_<note>_<dynamic>_<mode>_<44k1|96k>_<pcm16|pcm24|f32>.wav`. The scorer only uses `truth.json`.

## commands.tsv
Unchanged: `file<TAB>engine options` with exactly the flags of `scripts/tuner-json.mjs`
(`--a4 440 --tolerance 3`, plus `--targets <MIDI,...>` and `--locked <i>` in instrument / locked mode).

## truth.json
`{ version: 1, created, kind, generator, a4, tolerance_cents, files: [File] }`

File fields as in the synthetic set (`file`, `group`, `tags`, `instrument`, `sampleRate`, `format`, `channels`,
`duration_s`, `a4`, `mode`, `targets`, `locked`, `tolerance_cents`, `args`, `gain_applied_db`, `segments`), plus
**REAL**:
- `source`: library, download URL, original file name, SHA-256 of the downloaded bytes, HTTP byte range (piano and
  guitar files were fetched partially), index of the note in the source scale, excerpt start/end in source seconds,
  how much pre-roll came from the source and how much is zero padding, the downmix.
- `background`: room-noise RMS before the onset (dBFS; `null` = digital silence) and its kind. There is no added
  noise, hum or click in this set.
- tags: `mode:<chromatic|auto|locked>`, `dyn:<pp|mf|ff>`, `variant` (same audio as another file, other engine
  mode — excluded from every bucket so each recording counts once), `harmonic-test`, `A4-safety`, `vibrato`,
  `low<70Hz`, `preroll-zero-pad`.

Segments: `nothing` (before the onset; after the note has died away and the 1.5 s hold has passed), `reading`,
`dont_care` (`truth_of` = 1). One reading per file. `grace_s` is always 0. There is no `nothing_or_noisy`.

Reading segment fields — as in the synthetic set (`t0`, `t1`, `onset`, `hz`, `midi`, `note`, `cents`, `a4`,
`target_midi`, `target_index`, `cents_vs_target`, `expected_status`, `settle_budget_ms`, `eval_from`, `snr_db`,
`a3_bucket`, `modulated`, `octave_ambiguous` (always false), `steady`, `prev_hz` (always null),
`inharmonicity_B`, `model`), with these **REAL** differences:

| field | meaning |
|---|---|
| `hz` | median over the evaluation span of the measured first-partial curve (`hz_curve`) |
| `hz_curve` | **every** reading has it: `[[t, hz], …]` every 10 ms; `t` = CENTRE of the analysis window (0.12 s, or 12 periods for low notes; 0.05 s / 6 periods on vibrato notes) |
| `hz_period`, `hz_curve_period` | second, engine-like reference: single-period NSDF on a 4096-sample window (8192 below 70 Hz, doubled at 96 kHz) whose END is `t`, every 10 ms; `hz_period` = its median over the evaluation span |
| `modulated` | vibrato or fast pitch movement (rms deviation from the 0.5 s moving mean > 2 c); the scorer then uses the synthetic lookback rule on `hz_curve` |
| `steady` | not modulated and the pitch spread (p2–p98 over the evaluation span) ≤ 3 c (used for the display-stability check) |
| `expected_status` | SPEC §5.4 statuses for every deviation the note actually takes (its own p2–p98 spread ± 1 c); `null` for modulated notes; harmonic-test files: `["harmonic", "muchTooHigh"]`; auto-mode notes within 50 c of 2×/3×/4× of a string also allow `harmonic` |
| `alt_target_midis` | auto mode only: strings of which the note is a 2nd/3rd/4th partial (a `harmonic` frame naming one of these counts as the right target) |
| `harmonic_k` | harmonic-test files: the note is k × the locked string (k = 2, 3, 4) |
| `real_bucket` | replaces `a2_bucket`: `steady_harmonic` (bowed/wind 40–1000 Hz, no vibrato), `pluck_first_partial` (pizzicato), `piano_first_partial`, `high_1000_2100`, `vibrato`, (`low_below_40` is empty); `null` on variants |
| `a3_bucket` | `snr20plus` (all base files: SNR 32–60 dB or digital-silence background), `null` on variants |
| `settle_budget_ms` | 150 (plucked/piano 82–1000 Hz), 300 (< 70 Hz), else null; bowed/wind null |
| `eval_from` | onset + attack (time to −3 dB of the peak, ≤ 0.6 s) + 0.15 s (0.3 s below 70 Hz) |
| `t1` (end of the reading) | earliest of: the truth curve stops (5 invalid frames, or a jump > 15 c — 40 c on vibrato — from the previous 0.3 s: bow/breath release, damping), level below max(−60, min(−50, peak − 30)) dBFS, onset + 2.4 s (plucked) / 4.4 s (sustained), end of the excerpt |
| `ref` | reference quality: `analysis_window_s`, `a_minus_b_median_abs_cents` (first-partial fit vs a multi-period time-domain check), `pitch_slope_cents_per_s`, `ref_u_cents` (see README), `spread_p2_p98_cents`, `vibrato_rms_cents`, `period_vs_first_partial_cents` (`hz_period` vs `hz`), method texts |
| `catalogue` | the Iowa note name for this excerpt, our estimate's offset from it at A4 = 440, how it was assigned (`position` / `aligned`), `check` (`pass` in the main set, `fail>5c` in the supplement) |

## Engine output (input of check.py)
Unchanged from the synthetic set (`{ file, sampleRate, frames: [{ t, hz, noteMidi, targetMidi, stringIndex, cents,
displayCents, status, stable, held, harmonic?, harmonicCents? }] }`). **REAL**: status `harmonic` counts as showing
a reading; `harmonicCents` is not scored.

## discards.json (main folder)
Every note of the downloaded scales that is not in the main set, with the reason (591 records; 306 of them are the
notes in `supplement/`).
