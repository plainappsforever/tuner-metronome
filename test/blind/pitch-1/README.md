# Blind pitch set O1 (synthetic) — tuner engine

Written 2026-10-16 by a separate oracle agent for SPEC §13.2 (O1) / acceptance A2–A5. Independence: the oracle
read only `docs/SPEC.md`, `docs/V1_PLAN.md` and the first 40 lines of `scripts/tuner-json.mjs` (header comment with
the output format and flags, plus its WAV reader); it never read `src/` or `test/`. The synthesizer is its own (Python standard library, seeded, deterministic) and
is **not** included here, so the set cannot be tuned against. Real recordings are not included (they need the
owner's approval); this set is synthetic only.

Protocol (SPEC §13.2): commit the engine snapshot first, then copy this folder in, run it **once**, record the
numbers. Any engine change made after looking at the results turns this into a tuning set.

## Contents
- 404 WAV files (mono; 48 kHz float32 119, 44.1 kHz 16-bit 117, 48 kHz 16-bit 91, 44.1 kHz float32 77), 21.6 min.
- `truth.json` — ground truth per file and per time segment (format: `FORMAT.md`).
- `commands.tsv` — engine options per file. `run_engine.sh` — runs the engine on all files.
- `check.py` — scorer (Python 3 standard library). `MANIFEST.sha256` — checksums of every file in this folder.

## How to run
```sh
sh run_engine.sh <app repo folder> <output folder>     # ~404 node runs, one JSON per WAV
python3 check.py <output folder>                       # report on stdout
python3 check.py <output folder> --json report.json    # + machine-readable report (per group, bucket, file)
python3 check.py <output folder> --file 251_           # frame-by-frame view of one file
shasum -a 256 -c MANIFEST.sha256                       # set unchanged?
```
Options: `--t-offset S` if the engine's frame time `t` is not the newest sample of its window; `--lookback S`
(default 0.2) = how far back a reading of a modulated note may lag; `--group G` scores only matching groups.

## Groups (files) and what they test
| group | n | content |
|---|---|---|
| pluck-guitar | 20 | every string of standard guitar (E2…E4), acoustic/electric pluck models, auto / chromatic / locked + 100 Hz phone-mic high-pass; drop D (D2) |
| pluck-guitar-ext | 6 | 7-string low B1 (61.7 Hz) and 8-string low F♯1 (46.2 Hz) |
| pluck-bass | 14 | 4-string E1 A1 D2 G2 (3 variants each), 6-string high C3 |
| pluck-bass-lowB | 7 | 5-string low B0 (30.9 Hz) with B = 3e-4, 8e-4, 1.5e-3 (strong inharmonicity), with/without phone-mic high-pass |
| below-range | 4 | F♯0 (23.1 Hz, 7-string bass) — below SPEC's 27 Hz detector floor; reported, not in A2 |
| pluck-ukulele | 18 | GCEA re-entrant, low-G, baritone DGBE |
| pluck-pizz | 10 | violin pizzicato G3 D4 A4 E5 (short 0.9 s T60), cello C2, double bass E1 |
| pluck-banjo | 5 | 5-string open G (gDGBD incl. short G4 string) |
| pluck-12string | 6 | 12-string courses: octave pairs E2/E3, A2/A3, D3/D4, G3/G4 and unisons B3, E4 played together (truth = lower string) |
| pluck-glide | 4 | plucks starting 4–10 cents sharp (tension modulation) relaxing over 0.2–0.35 s (truth curve) |
| bowed-vibrato | 16 | violin, viola, cello, double bass, every open string, vibrato ±10 cents at 5–6 Hz (truth curve) |
| bowed-steady | 16 | same strings without vibrato, small detunes, auto/locked |
| sustain-long | 3 | 4.5 s sustained cello/flute/tone (a reading must stay up for the whole sustain) |
| wind / wind-vibrato | 23 / 2 | flute C4–C7 (2093 Hz), clarinet (odd harmonics), oboe/bassoon (weak fundamental), sax, trumpet, tuba (F1, D1) |
| synth-harmonic | 40 | plain harmonic tones from B0 (30.9 Hz) to C7 (2093 Hz) with random detune, two levels |
| detune-guitar / -bass / -chromatic | 24 / 8 / 8 | ±5, ±15, ±40, ±49 cents on guitar E2/G3/E4 (auto), bass E1 (locked), bowed A4 (chromatic) |
| a4-ref | 18 | notes tuned to A4 = 415, 432, 440, 442, 466 with the engine at the same A4; plus mismatches (440-tuned vs 432, 442 vs 440, 415 vs 440, 466-tuned E2 vs 440) |
| decay-4s | 9 | plucks with T60 = 4 s over 4.2 s: E1, B0, E2 (twice each, A5 octave flips), A1, D3, B3 |
| snr30 / snr20 / snr10 | 12 each | 12 sources (plucks, bowed, wind, tones, B0…E6) in white / pink / room / fan noise at 30, 20, 10 dB SNR |
| noise-alone | 10 | white, pink, brown, room, fan noise −50…−15 dBFS; a quiet-to-loud step |
| hum-alone | 10 | 50 / 60 Hz (and 49.95 / 60.05 Hz) mains hum, pure / buzz / transformer (strong 100/120 Hz) harmonics |
| hum-under | 12 | E2 A2 D3 E1 A1 plucks and a bowed G3 entering after 2.5 s of hum, SNR 20 and 10 dB |
| click-alone / click-beep-alone | 8 / 2 | woodblock, noise, tick metronome clicks 60–300 BPM incl. 16ths; 880 Hz beep clicks |
| click-mixed | 8 | notes with clicks whose peak is 6 dB above the note's RMS (SPEC U8 "tune while it clicks") |
| string-change | 14 | two notes in quick succession (250–600 ms), first ringing on or damped; retune-and-repluck; bowed string crossing |
| bend | 6 | 50-cent bends over 1 s, up and down, crossing note boundaries (truth curve) |
| missing-fundamental | 10 | harmonics 2–8/2–10/2–12 only, odd-only, 150 Hz 4th-order high-passed low strings, oboe-like weak fundamental |
| octave-ambiguous | 2 | only even harmonics with a −30 dB fundamental / a weak 3rd harmonic: note or its octave accepted |
| silence | 5 | digital zero, dither only, −80 dBFS noise, 1.5 s zero in guitar mode |
| safety-octave | 13 | locked string with the played note ≥ 1 octave away (E3 on E2, E5 on E4, E1 on E2, B1 on B0 …), +700 c, auto-mode E5 |
| quiet / clipped / sympathetic | 2 / 2 / 3 | −45/−50 dBFS notes; hard-clipped plucks; a second open string ringing 20 dB lower |

Physical models: plucks are modal stiff strings (partials at n·f0·√(1+B·n²), pluck-position comb, brightness
low-pass, body resonances, decay that grows with frequency, pick-noise transient); B values are typical for each
string (guitar 8e-5…2.5e-4, bass 1.5e-4…4.5e-4, low B 3e-4…1.5e-3, nylon 1.5e-5…6e-5). Bowed tones are exactly
harmonic (Helmholtz motion) with bow-position comb, body resonances, amplitude jitter and bow noise.

## What check.py measures
Per group and per SPEC bucket: cents error of shown frames (median / p95 / max), coverage (share of evaluation
frames that show any reading — accuracy numbers only mean something next to it), right-note rate (octave included),
target-string rate, status-in-expected-set rate, harmonic errors (off by 7/12/19/24 semitones), false readings on
nothing/noise/hum/click segments, `noisy` on silence, wrong direction ("tighten" while > tol+2 c sharp of the
engine's own target, "loosen" while flat), settle time (onset → first `stable` frame within ±2 c), latency in frames
(onset → first right-note frame; onset → settle), tail behaviour, and displayCents jumps on steady tones.

SPEC acceptance lines printed at the end:
- **A2** (A1 limits on this set): core median ≤ 0.5 c and p95 ≤ 1.0 c; inharmonic plucks p95 ≤ 1.5 c vs the first
  partial; 30–40 Hz and 1000–2100 Hz p95 ≤ 2.0 c. B > 5e-4 and below-range are reported without a limit.
- **A3**: right note ≥ 99.5 % of shown frames at SNR ≥ 20 dB, ≥ 97 % at 10 dB; hum alone: 0 false frames after the
  2.2 s grace (frames inside the grace are printed separately); noise alone ≤ 1 % false frames.
- **A4**: 0 "tighten" (`flat`/`veryLow`) frames on notes ≥ 1 octave sharp of the target; plus the §9 guard (no
  "tighten" when > 300 c above the engine's own target, all files) and wrong-direction counts.
- **A5**: every budgeted pluck onset settles within 150 ms (82–1000 Hz) / 300 ms (< 70 Hz); 0 harmonic errors on the
  4 s E1/B0/E2 decays; displayCents changes ≤ 1 between consecutive frames on steady tones.

## Points to read the numbers by (honest caveats)
- Frame time convention and status semantics are assumptions from the script header (FORMAT.md). If `t` is the
  window start, settle times look one window longer than they are: rerun with `--t-offset <window s>`.
- `--locked` is passed as a 0-based string index. If the engine reads it differently, the target-rate column of the
  locked files shows it at once.
- Inference from the SPEC text, not tested against the engine: a noise floor taken as the 10th percentile of the
  last 3 s would rise to the level of any steady note held longer than ~2.7 s and close the gate; the
  `sustain-long` group exists to show whether that happens. Other groups keep required readings within 2.4 s of the
  onset with ≥ 0.5 s pre-roll so they do not test it.
- SNR is defined at the note's start (FORMAT.md); decaying plucks in noise are only required while their local SNR
  is within 6 dB of that, so "snr10" frames lie between 10 and 4 dB.
- The hum rule needs ≥ 2 s; readings of hum in the first 2.2 s are printed but not counted as A3 failures.
- Truth check by the oracle: an independent phase-demodulation measurement of the first partial in every
  constant-pitch reading segment (339) agrees with `hz` to a median of 0.0001 cents; the largest deviations
  (≤ 0.33 c) are in 10 dB-SNR, clipped and string-change files, where noise/interference is the point.
- Simulated audio does not prove behaviour on phone microphones or real instruments (A8 is a real-device test).
