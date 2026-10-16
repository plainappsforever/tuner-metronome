#!/usr/bin/env python3
"""Per-instrument and per-octave breakdown of a real-recording blind set (test/blind/real-1), base files only.

Scores the SAME engine outputs with the oracle's own check.py (imported unchanged from the set folder, same
evaluate_file / summarize), only grouping the frames differently: per group (instrument + articulation) and per
octave of the played note (scientific pitch, from truth `midi`). Variants (same audio, other engine mode) and the
harmonic-test files are left out so each recording counts once; harmonic tests are in check.py's own report.
It never runs the engine. Usage (from anywhere):
  python3 -I scripts/blind-real-breakdown.py <set dir> <engine output dir> [--vs local|period|median] [--both]
  (supplement: <set dir> = test/blind/real-1/supplement; check.py is taken from its parent folder)
"""
import importlib.util
import os
import sys

sys.dont_write_bytecode = True  # no __pycache__ in the blind-set folder

setdir, outdir = sys.argv[1], sys.argv[2]
vs = sys.argv[sys.argv.index('--vs') + 1] if '--vs' in sys.argv else 'local'
chk = os.path.join(setdir, 'check.py')
if not os.path.exists(chk):  # the supplement folder uses the main folder's check.py
    chk = os.path.join(os.path.dirname(os.path.abspath(setdir)), 'check.py')
spec = importlib.util.spec_from_file_location('blind_check', chk)
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)
C.VS = vs
import json  # noqa: E402

truth = json.load(open(os.path.join(setdir, 'truth.json')))
outs, bad = C.load_outputs(outdir)
by_group, by_oct, by_both = {}, {}, {}
first_ms = {}
gacc = dict(dir_frames=0, tighten_above_300=[], a4_frames=0, a4_viol=[], a4_loosen_low=[])
wrong = {}
for t in truth['files']:
    if 'variant' in t.get('tags', []) or 'harmonic-test' in t.get('tags', []) or t['file'] not in outs:
        continue
    rd = [d for d in t['segments'] if d['expect'] == 'reading']
    octv = rd[0]['midi'] // 12 - 1
    g = t['group']
    G = by_group.setdefault(g, C.Acc())
    O = by_oct.setdefault(octv, C.Acc())
    B = by_both.setdefault((g, octv), C.Acc())
    for A in (G, O, B):
        A.merge_file(t['file'])
    FA = C.Acc()
    info = C.evaluate_file(t, outs[t['file']], lambda s, r=[G, O, B, FA]: r, 0.2, 0.0, global_acc=gacc)
    for o in info['onsets']:
        if o['first_correct_ms'] is not None:
            first_ms.setdefault(('g', g), []).append(o['first_correct_ms'])
            first_ms.setdefault(('o', octv), []).append(o['first_correct_ms'])
    if FA.wrong_tighten or FA.wrong_loosen:
        wrong[t['file']] = (FA.wrong_tighten, FA.wrong_loosen, FA.dir_frames)


def f(v, n=2):
    return '-' if v is None else f'{v:.{n}f}'


def table(title, d, key):
    print(f'\n{title} (truth = {vs}; base files only)')
    print('| row | files | evalF | cover% | med c | p95 c | max c | note% | stat% | harm | wDir T/L | false% | settled | '
          'setl50 | setl95 | 1st50 | 1st95 | jumps>1c |')
    print('|---|' + '---|' * 17)
    for k in sorted(d, key=lambda x: (str(x[0]), x[1]) if isinstance(x, tuple) else x):
        s = C.summarize(d[k])
        fm = first_ms.get((key, k), [])
        print(f'| {k if not isinstance(k, tuple) else f"{k[0]} oct {k[1]}"} | {s["files"]} | {s["eval_frames"]} | '
              f'{f(s["coverage_pct"], 1)} | {f(s["median_abs_cents"])} | {f(s["p95_abs_cents"])} | '
              f'{f(s["max_abs_cents"], 1)} | {f(s["right_note_pct"], 1)} | {f(s["status_ok_pct"], 1)} | '
              f'{s["harmonic_errors"]} | {s["wrong_tighten"]}/{s["wrong_loosen"]} | {f(s["false_reading_pct"], 1)} | '
              f'{s["settled"]}/{s["onsets"]} | {f(s["settle_median_ms"], 0)} | {f(s["settle_p95_ms"], 0)} | '
              f'{f(C.median(fm), 0) if fm else "-"} | {f(C.pct(fm, 95), 0) if fm else "-"} | {s["steady_display_jump_viol"]} |')


table('Per group (instrument + articulation)', by_group, 'g')
table('Per octave of the played note', by_oct, 'o')
if '--both' in sys.argv:
    table('Per group and octave', by_both, 'b')
print('\nWrong-direction frames per base file (tighten while sharp / loosen while flat, of flat/sharp frames):')
for k, (a, b, n) in sorted(wrong.items(), key=lambda kv: -(kv[1][0] + kv[1][1])):
    print(f'  {k}: {a}/{b} of {n}')
# Safety lists over ALL files (variants and harmonic tests included, as in check.py's A4 / SPEC 9 lines)
import collections  # noqa: E402
sacc = dict(dir_frames=0, tighten_above_300=[], a4_frames=0, a4_viol=[], a4_loosen_low=[])
for t in truth['files']:
    if t['file'] in outs:
        C.evaluate_file(t, outs[t['file']], lambda s: [], 0.2, 0.0, global_acc=sacc)
print(f'\nA4 safety (all files): {len(sacc["a4_viol"])} "tighten" frames while >= 1 octave sharp of the target, '
      f'of {sacc["a4_frames"]} shown frames on such notes')
for k, n in collections.Counter(x[0] for x in sacc['a4_viol']).most_common():
    ts = [x[1] for x in sacc['a4_viol'] if x[0] == k]
    print(f'  {k}: {n} frames, t {min(ts)}-{max(ts)} s')
print(f'SPEC 9 guard (all files): {len(sacc["tighten_above_300"])} "tighten" frames while > 300 c above the engine target')
for k, n in collections.Counter(x[0] for x in sacc['tighten_above_300']).most_common():
    ts = [x[1] for x in sacc['tighten_above_300'] if x[0] == k]
    print(f'  {k}: {n} frames, t {min(ts)}-{max(ts)} s')
print('\nColumns: as check.py; settled = onsets reaching stable within +-2 c / onsets; setl50/95 = settle ms of the '
      'settled onsets; 1st50/95 = ms from onset to the first right-note frame (latency); jumps>1c = steady-display '
      'violations; false% = readings on nothing-segments (pre-roll room noise, after the note died away).')
