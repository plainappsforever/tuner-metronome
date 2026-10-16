#!/usr/bin/env python3
"""Scorer for the REAL-RECORDING blind set (Iowa MIS notes) of the tuner engine (Python 3 standard library only).
Derived from the synthetic set's check.py (same engine-output format, same columns); differences are marked REAL.

Usage:
  python3 check.py OUTPUTS [--set DIR] [--t-offset S] [--lookback S] [--window S] [--vs local|median|period]
                   [--json report.json] [--file NAME] [--group G] [--all]

OUTPUTS  a folder of engine outputs (*.json / *.jsonl / *.ndjson / *.txt; each may hold one or more JSON objects
         { file, sampleRate, frames: [...] } as printed by scripts/tuner-json.mjs) or a single such file.
--set    the blind-set folder holding truth.json (default: the folder this script lives in).
--t-offset  seconds added to every frame time t (default 0: t is taken as the time of the NEWEST sample in the
            analysis window). If the engine's t is the window start/centre, pass the shift here.
--lookback  seconds of truth history a reading may reflect on modulated notes (vibrato); default 0.2.
--window S  REAL: length of the engine's analysis window used to average the measured truth curve for non-modulated
            notes (default per file: 4096 samples, 8192 for notes < 70 Hz or instrument targets < 70 Hz, doubled at
            >= 88.2 kHz; SPEC 5.3 step 1). The truth for a frame at t = mean of the curve over [t - window, t].
--vs        REAL: truth used for cents errors: local (default; measured first-partial curve, see --window), median
            (one frequency per note = median over its evaluation span), period (time-domain period curve, method B;
            shows how much of an error on plucked/inharmonic notes is the first-partial-vs-period definition).
--all       REAL: also print every flagged file (default: 40).
--file   print a frame-by-frame evaluation of one file (name or unique substring) and exit.
--group  only score groups whose name contains this substring.
See FORMAT.md for the truth format and README.md for every metric.
"""
import json
import math
import os
import sys

# REAL: 'harmonic' (engine status: the note is the 2nd/3rd/4th partial of the target string) shows a reading
SHOWN = {'flat', 'sharp', 'inTune', 'muchTooHigh', 'veryLow', 'harmonic'}
HARMONIC_OK = {'harmonic', 'muchTooHigh'}
TIGHTEN = {'flat', 'veryLow'}
LOOSEN = {'sharp', 'muchTooHigh'}
HARMONIC_ERR = {12, -12, 24, -24, 19, -19, 7, -7}


def arg(name, default=None, cast=str):
    if name in sys.argv:
        return cast(sys.argv[sys.argv.index(name) + 1])
    return default


def mhz(m, a4):
    return a4 * 2.0 ** ((m - 69) / 12.0)


def cents(f, ref):
    return 1200.0 * math.log2(f / ref)


def nearest_midi(f, a4):
    return math.floor(69 + 12 * math.log2(f / a4) + 0.5)


def pct(v, p):
    if not v:
        return None
    s = sorted(v)
    k = max(0, min(len(s) - 1, math.ceil(p / 100.0 * len(s)) - 1))
    return s[k]


def median(v):
    if not v:
        return None
    s = sorted(v)
    n = len(s)
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


def load_outputs(path):
    files = []
    if os.path.isdir(path):
        for n in sorted(os.listdir(path)):
            if n.endswith(('.json', '.jsonl', '.ndjson', '.txt')) and not n.startswith('report'):
                files.append(os.path.join(path, n))
    else:
        files = [path]
    out = {}
    dec = json.JSONDecoder()
    bad = []
    for p in files:
        txt = open(p, encoding='utf-8', errors='replace').read()
        i = 0
        while True:
            while i < len(txt) and txt[i] in ' \t\r\n,':
                i += 1
            if i >= len(txt):
                break
            try:
                v, i = dec.raw_decode(txt, i)
            except json.JSONDecodeError:
                bad.append(os.path.basename(p))
                break
            for o in (v if isinstance(v, list) else [v]):
                if isinstance(o, dict) and 'frames' in o and 'file' in o:
                    out[os.path.basename(str(o['file']))] = o
    return out, bad


VS = 'local'
WINDOW = None


class Seg:
    def __init__(self, d, all_segs, win=0.085):
        self.d = d
        self.t0, self.t1, self.expect = d['t0'], d['t1'], d['expect']
        self.truth = d if self.expect == 'reading' else (all_segs[d['truth_of']] if 'truth_of' in d else None)
        tr = self.truth
        self.win = win
        self.mod = bool(tr and tr.get('modulated'))
        # REAL: every reading has a measured curve; modulated notes use the synthetic lookback rule on it,
        # the others the mean over the engine window (or the note median / the period curve, see --vs)
        self.curve = None
        self.lcurve = None
        self.pcurve = None
        if tr:
            if VS == 'period' and tr.get('hz_curve_period'):
                # period curve: times are the END of an engine-like window, so the value at t is used directly
                if self.mod:
                    self.curve = tr['hz_curve_period']
                else:
                    self.pcurve = tr['hz_curve_period']
            elif VS != 'median' and tr.get('hz_curve'):
                if self.mod:
                    self.curve = tr['hz_curve']
                else:
                    self.lcurve = tr['hz_curve']

    def local_hz(self, t):
        c = self.lcurve
        lo, hi = t - self.win, t
        vals = [f for tt, f in c if lo <= tt <= hi]
        if vals:
            return sum(vals) / len(vals)
        best = min(c, key=lambda p: abs(p[0] - (t - self.win / 2)))
        return best[1]

    def hz_at(self, t):
        tr = self.truth
        if self.lcurve:
            return self.local_hz(t)
        if self.pcurve:
            return min(self.pcurve, key=lambda p: abs(p[0] - t))[1]
        if not self.curve:
            return tr['hz']
        c = self.curve
        t0 = c[0][0]
        x = (t - t0) / 0.01  # REAL: curves are sampled every 10 ms
        i = int(math.floor(x))
        if i <= 0:
            return c[0][1]
        if i >= len(c) - 1:
            return c[-1][1]
        u = x - i
        return c[i][1] * (1 - u) + c[i + 1][1] * u

    def hz_range(self, t, lookback):
        if not self.curve:
            f = self.hz_at(t)
            return f, f
        vals = [self.hz_at(t), self.hz_at(max(self.truth['t0'], t - lookback))]
        for tt, f in self.curve:
            if t - lookback <= tt <= t:
                vals.append(f)
        return min(vals), max(vals)


def seg_at(segs, t):
    for s in segs:
        if s.t0 <= t < s.t1:
            return s
    return segs[-1] if t >= segs[-1].t0 else segs[0]


def is_shown(fr):
    st = fr.get('status')
    held = bool(fr.get('held'))
    if st is None:
        return (fr.get('hz') is not None) and not held
    return st in SHOWN and not held


class Acc:
    """Accumulator for one group / bucket."""

    def __init__(self):
        self.files = set()
        self.err = []          # |cents error| of shown frames in the evaluation window
        self.eval_frames = 0
        self.shown = 0
        self.note_ok = 0
        self.tgt_n = 0
        self.tgt_ok = 0
        self.stat_n = 0
        self.stat_ok = 0
        self.disp_n = 0
        self.disp_ok = 0
        self.harm_err = 0
        self.tail_shown = 0
        self.tail_note_ok = 0
        self.tail_harm = 0
        self.none_frames = 0
        self.none_false = 0
        self.none_grace_frames = 0
        self.none_grace_false = 0
        self.none_noisy_wrong = 0
        self.noisy_frames = 0
        self.wrong_tighten = 0
        self.wrong_loosen = 0
        self.dir_frames = 0
        self.settle = []       # ms, None = never
        self.settle_fail = 0
        self.settle_budgeted = 0
        self.first_frames = []
        self.settle_frames = []
        self.first_ms = []
        self.disp_jump_max = 0.0
        self.disp_jump_viol = 0
        self.harm_n = 0        # REAL: shown eval frames on harmonic-test files (locked string, note = 2x/3x/4x)
        self.harm_ok = 0       # ... with status harmonic or muchTooHigh
        self.harm_status = 0   # ... with status harmonic
        self.ref_u = []        # REAL: reference uncertainty (cents) of the truth behind each scored frame
        self.def_gap = []      # REAL: |period (method B) - first partial (method A)| of the note, cents

    def merge_file(self, name):
        self.files.add(name)


def evaluate_file(tf, out, accs_for, lookback, toff, dump=False, global_acc=None):
    a4 = tf['a4']
    tol = tf.get('tolerance_cents', 3)
    segs_raw = tf['segments']
    win = WINDOW
    if win is None:
        sr = tf['sampleRate']
        rd = [d for d in segs_raw if d['expect'] == 'reading']
        low = any(d['hz'] < 70 for d in rd) or bool(tf.get('targets') and min(mhz(m, a4) for m in tf['targets']) < 70)
        win = (8192 if low else 4096) * (2 if sr >= 88200 else 1) / sr
    segs = [Seg(d, segs_raw, win) for d in segs_raw]
    frames = out.get('frames') or []
    dur = tf['duration_s']
    ts = [fr.get('t') for fr in frames if isinstance(fr.get('t'), (int, float))]
    scale = 0.001 if ts and max(ts) > dur * 1.5 + 1.0 else 1.0
    info = dict(file=tf['file'], group=tf['group'], frames=len(frames), t_scale=scale, onsets=[])
    if len(ts) > 2:
        dts = sorted((b - a) * scale for a, b in zip(ts, ts[1:]))
        info['frame_dt_ms'] = round(1000 * dts[len(dts) // 2], 2)
    prev_shown_disp = None
    onset_state = {}
    for k, fr in enumerate(frames):
        t = fr.get('t')
        if not isinstance(t, (int, float)):
            continue
        t = t * scale + toff
        s = seg_at(segs, t)
        accs = accs_for(s)
        shown = is_shown(fr)
        st = fr.get('status')
        hz = fr.get('hz')
        line = None
        if s.expect in ('nothing', 'nothing_or_noisy'):
            grace = s.d.get('grace_s', 0.0) or 0.0
            ing = t < s.t0 + grace
            for A in accs:
                if ing:
                    A.none_grace_frames += 1
                    A.none_grace_false += shown
                else:
                    A.none_frames += 1
                    A.none_false += shown
                    if st == 'noisy':
                        A.noisy_frames += 1
                        if s.expect == 'nothing':
                            A.none_noisy_wrong += 1
            prev_shown_disp = None
            if dump:
                line = f'{t:7.3f} {s.expect:16s} {"SHOWN" if shown else "":5s} st={st} hz={hz}'
        elif s.truth is not None:
            tr = s.truth
            lo, hi = s.hz_range(t, lookback)
            fnow = s.hz_at(t)
            midi = tr['midi']
            in_eval = s.expect == 'reading' and tr['eval_from'] <= t <= s.t1
            err = None
            if shown and isinstance(hz, (int, float)) and hz > 0:
                if s.lcurve or s.pcurve or VS == 'median':
                    err = cents(hz, fnow)
                elif s.curve:
                    err = cents(hz, lo) if hz < lo else (cents(hz, hi) if hz > hi else 0.0)
                else:
                    err = cents(hz, tr['hz'])
                if tr.get('octave_ambiguous'):
                    err = err - 1200 * round(err / 1200)
            nm = fr.get('noteMidi')
            if nm is None and isinstance(hz, (int, float)) and hz > 0:
                nm = nearest_midi(hz, a4)
            if s.curve or s.lcurve or s.pcurve:  # REAL: a drifting note may cross a note boundary (+-50 c)
                ok_notes = {midi, nearest_midi(lo, a4), nearest_midi(hi, a4), nearest_midi(fnow, a4)}
            elif tr.get('octave_ambiguous'):
                ok_notes = {midi, midi + 12}
            else:
                ok_notes = {midi}
            note_ok = shown and nm in ok_notes
            harm = shown and nm is not None and (nm - midi) in HARMONIC_ERR and not tr.get('octave_ambiguous') \
                and not s.curve
            # wrong direction (any reading or tail frame)
            tgt = fr.get('targetMidi')
            if tgt is None:
                tgt = nm
            wrong_t = wrong_l = False
            if shown and st in (TIGHTEN | LOOSEN) and tgt is not None:
                ft = mhz(tgt, a4)
                cands = [(cents(lo, ft), cents(hi, ft))]
                if s.expect == 'reading' and tr.get('prev_hz') and t < tr['t0'] + 0.3:
                    pc = cents(tr['prev_hz'], ft)
                    cands.append((pc, pc))
                if s.expect == 'reading' and t < tr['t0'] + 0.3 and not tr.get('prev_hz'):
                    pass
                margin = tol + 2
                if st in TIGHTEN and all(c_lo > margin for c_lo, _ in cands):
                    wrong_t = True
                if st in LOOSEN and all(c_hi < -margin for _, c_hi in cands):
                    wrong_l = True
                if global_acc is not None:
                    global_acc['dir_frames'] += 1
                    if st in TIGHTEN and all(c_lo > 300 for c_lo, _ in cands):
                        global_acc['tighten_above_300'].append((tf['file'], round(t, 3)))
            if tr.get('cents_vs_target') is not None and abs(tr['cents_vs_target']) >= 1160 and shown \
                    and global_acc is not None:
                global_acc['a4_frames'] += 1
                if tr['cents_vs_target'] > 0 and st in TIGHTEN:
                    global_acc['a4_viol'].append((tf['file'], round(t, 3), st))
                if tr['cents_vs_target'] < 0 and st in LOOSEN:
                    global_acc['a4_loosen_low'].append((tf['file'], round(t, 3), st))
            for A in accs:
                if shown and st in (TIGHTEN | LOOSEN):
                    A.dir_frames += 1
                A.wrong_tighten += wrong_t
                A.wrong_loosen += wrong_l
            if in_eval:
                for A in accs:
                    A.eval_frames += 1
                    if shown:
                        A.shown += 1
                        if err is not None:
                            A.err.append(abs(err))
                        A.note_ok += note_ok
                        A.harm_err += harm
                        if tr.get('target_midi') is not None and fr.get('targetMidi') is not None:
                            A.tgt_n += 1
                            A.tgt_ok += fr.get('targetMidi') == tr['target_midi'] or \
                                (st == 'harmonic' and fr.get('targetMidi') in (tr.get('alt_target_midis') or []))
                        if tr.get('harmonic_k'):
                            A.harm_n += 1
                            A.harm_ok += st in HARMONIC_OK
                            A.harm_status += st == 'harmonic'
                        A.ref_u.append(tr.get('ref', {}).get('ref_u_cents') or 0.0)
                        g = tr.get('ref', {}).get('period_vs_first_partial_cents')
                        if g is not None:
                            A.def_gap.append(abs(g))
                        if tr.get('expected_status'):
                            A.stat_n += 1
                            A.stat_ok += st in tr['expected_status']
                        dc = fr.get('displayCents')
                        if isinstance(dc, (int, float)) and not s.curve and fr.get('targetMidi') is not None \
                                and isinstance(hz, (int, float)) and st != 'harmonic':
                            ctrue = cents(fnow, mhz(fr['targetMidi'], a4))
                            if abs(ctrue) < 600:
                                A.disp_n += 1
                                A.disp_ok += abs(dc - ctrue) <= 1.0
                if tr.get('steady'):
                    dc = fr.get('displayCents')
                    if shown and isinstance(dc, (int, float)):
                        if prev_shown_disp is not None and prev_shown_disp[0] == k - 1:
                            j = abs(dc - prev_shown_disp[1])
                            for A in accs:
                                A.disp_jump_max = max(A.disp_jump_max, j)
                                A.disp_jump_viol += j > 1.0 + 1e-9
                        prev_shown_disp = (k, dc)
                    else:
                        prev_shown_disp = None
            elif s.expect == 'dont_care':
                for A in accs:
                    if shown:
                        A.tail_shown += 1
                        A.tail_note_ok += note_ok
                        A.tail_harm += harm
            # onset / settle bookkeeping
            if s.expect == 'reading' and tr.get('onset'):
                key = id(s)
                o = onset_state.setdefault(key, dict(seg=s, n=0, first=None, settle=None, first_ms=None))
                o['n'] += 1
                if shown and o['first'] is None and note_ok:
                    o['first'] = o['n']
                    o['first_ms'] = (t - tr['t0']) * 1000
                if o['settle'] is None and shown and bool(fr.get('stable')) and err is not None and abs(err) <= 2.0:
                    o['settle'] = ((t - tr['t0']) * 1000, o['n'])
            if dump:
                e = f'{err:+8.2f}' if err is not None else '     n/a'
                line = (f'{t:7.3f} {s.expect:9s} {"EVAL" if in_eval else "":4s} truth={fnow:9.3f} {"SHOWN" if shown else "":5s}'
                        f' hz={hz} note={nm} tgt={fr.get("targetMidi")} st={st} stable={fr.get("stable")} '
                        f'held={fr.get("held")} disp={fr.get("displayCents")} err={e}'
                        f'{" WRONG-DIR" if (wrong_t or wrong_l) else ""}')
        if dump and line:
            print(line)
    # segments with onsets that got no frames at all still count
    for s in segs:
        if s.expect == 'reading' and s.d.get('onset') and id(s) not in onset_state:
            onset_state[id(s)] = dict(seg=s, n=0, first=None, settle=None, first_ms=None)
    for o in onset_state.values():
        s = o['seg']
        tr = s.truth
        budget = tr.get('settle_budget_ms')
        accs = accs_for(s)
        st_ms = o['settle'][0] if o['settle'] else None
        info['onsets'].append(dict(t0=tr['t0'], note=tr['note'], settle_ms=st_ms, budget_ms=budget,
                                   first_correct_frame=o['first'], first_correct_ms=o['first_ms']))
        for A in accs:
            A.settle.append(st_ms)
            if budget is not None:
                A.settle_budgeted += 1
                if st_ms is None or st_ms > budget:
                    A.settle_fail += 1
            if o['first'] is not None:
                A.first_frames.append(o['first'])
                A.first_ms.append(o['first_ms'])
            if o['settle']:
                A.settle_frames.append(o['settle'][1])
    return info


def f1(v, n=2):
    return '-' if v is None else f'{v:.{n}f}'


def rate(a, b):
    return None if b == 0 else 100.0 * a / b


def summarize(A):
    sv = [x for x in A.settle if x is not None]
    return dict(
        files=len(A.files), eval_frames=A.eval_frames, coverage_pct=rate(A.shown, A.eval_frames),
        median_abs_cents=median(A.err), p95_abs_cents=pct(A.err, 95), max_abs_cents=max(A.err) if A.err else None,
        right_note_pct=rate(A.note_ok, A.shown), target_ok_pct=rate(A.tgt_ok, A.tgt_n),
        status_ok_pct=rate(A.stat_ok, A.stat_n), display_cents_ok_pct=rate(A.disp_ok, A.disp_n),
        harmonic_errors=A.harm_err, tail_shown=A.tail_shown, tail_right_note_pct=rate(A.tail_note_ok, A.tail_shown),
        tail_harmonic_errors=A.tail_harm,
        nothing_frames=A.none_frames, false_reading_frames=A.none_false,
        false_reading_pct=rate(A.none_false, A.none_frames),
        grace_frames=A.none_grace_frames, grace_false=A.none_grace_false,
        noisy_frames=A.noisy_frames, noisy_on_silence=A.none_noisy_wrong,
        direction_frames=A.dir_frames, wrong_tighten=A.wrong_tighten, wrong_loosen=A.wrong_loosen,
        onsets=len(A.settle), settled=len(sv), settle_median_ms=median(sv), settle_p95_ms=pct(sv, 95),
        settle_max_ms=max(sv) if sv else None, settle_budgeted=A.settle_budgeted, settle_fail=A.settle_fail,
        first_correct_frames_median=median(A.first_frames), first_correct_frames_max=max(A.first_frames) if A.first_frames else None,
        first_correct_ms_median=median(A.first_ms), settle_frames_median=median(A.settle_frames),
        settle_frames_max=max(A.settle_frames) if A.settle_frames else None,
        steady_display_jump_max=A.disp_jump_max, steady_display_jump_viol=A.disp_jump_viol,
        harmonic_frames=A.harm_n, harmonic_ok_pct=rate(A.harm_ok, A.harm_n), harmonic_status_pct=rate(A.harm_status, A.harm_n),
        ref_u_median_cents=median(A.ref_u), ref_u_p95_cents=pct(A.ref_u, 95),
        period_gap_median_cents=median(A.def_gap), period_gap_p95_cents=pct(A.def_gap, 95))


def main():
    if len(sys.argv) < 2 or sys.argv[1].startswith('-'):
        print(__doc__)
        sys.exit(2)
    outp = sys.argv[1]
    setdir = arg('--set', os.path.dirname(os.path.abspath(__file__)))
    global VS, WINDOW
    VS = arg('--vs', 'local')
    if VS not in ('local', 'median', 'period'):
        print('--vs must be local, median or period')
        sys.exit(2)
    WINDOW = arg('--window', None, float)
    toff = arg('--t-offset', 0.0, float)
    lookback = arg('--lookback', 0.2, float)
    gfilter = arg('--group')
    truth = json.load(open(os.path.join(setdir, 'truth.json')))
    outs, bad = load_outputs(outp)
    tfiles = [t for t in truth['files'] if (gfilter is None or gfilter in t['group'])]
    dump = arg('--file')
    if dump:
        m = [t for t in tfiles if dump in t['file']]
        if len(m) != 1:
            print(f'--file matches {len(m)} files')
            sys.exit(2)
        t = m[0]
        print(json.dumps({k: t[k] for k in ('file', 'group', 'instrument', 'a4', 'mode', 'targets', 'locked', 'args')}))
        for s in t['segments']:
            print('  seg', {k: v for k, v in s.items() if k not in ('hz_curve', 'hz_curve_period')})
        if t['file'] not in outs:
            print('no engine output for this file')
            sys.exit(1)
        evaluate_file(t, outs[t['file']], lambda s: [], lookback, toff, dump=True,
                      global_acc=dict(dir_frames=0, tighten_above_300=[], a4_frames=0, a4_viol=[], a4_loosen_low=[]))
        return
    groups = {}
    buckets = {}
    gacc = dict(dir_frames=0, tighten_above_300=[], a4_frames=0, a4_viol=[], a4_loosen_low=[])
    infos = []
    missing = []
    a5 = Acc()
    allb = Acc()   # REAL: every base file (variants that re-use the same audio are excluded)
    for t in tfiles:
        if t['file'] not in outs:
            missing.append(t['file'])
            continue
        G = groups.setdefault(t['group'], Acc())
        G.merge_file(t['file'])
        FA = Acc()
        FA.merge_file(t['file'])

        def accs_for(s, G=G, t=t, FA=FA):
            r = [G, FA]
            tr = s.truth
            if tr is not None:
                for key, pre in (('real_bucket', 'R'), ('a3_bucket', 'A3')):
                    b = tr.get(key)
                    if b:
                        B_ = buckets.setdefault(f'{pre}:{b}', Acc())
                        B_.merge_file(t['file'])
                        r.append(B_)
            if 'variant' not in t.get('tags', []) and tr is not None:
                allb.merge_file(t['file'])
                r.append(allb)
            if 'A5-decay' in t.get('tags', []):
                a5.merge_file(t['file'])
                r.append(a5)
            return r
        info = evaluate_file(t, outs[t['file']], accs_for, lookback, toff, global_acc=gacc)
        info['summary'] = summarize(FA)
        infos.append(info)
    # ---------------- report
    P = print
    P(f'REAL-recording blind set ({truth.get("kind", "")}): truth = {VS}')
    P(f'Blind set: {len(truth["files"])} files; scored {len(infos)}; missing outputs {len(missing)}'
      + (f'; unparsable output files: {bad}' if bad else ''))
    dts = [i.get('frame_dt_ms') for i in infos if i.get('frame_dt_ms')]
    if dts:
        P(f'Frame spacing (median over files): {median(dts):.1f} ms; t unit: '
          f'{"ms (auto-detected)" if any(i["t_scale"] != 1.0 for i in infos) else "s"}; t offset {toff} s; lookback {lookback} s')
    P('')
    hdr = (f'{"group":22s} {"files":>5s} {"evalF":>6s} {"cover%":>6s} {"med":>6s} {"p95":>6s} {"max":>7s} {"note%":>6s} '
           f'{"tgt%":>6s} {"stat%":>6s} {"harm":>4s} {"nothF":>6s} {"false%":>6s} {"noisy":>5s} {"wDirT":>5s} {"wDirL":>5s} '
           f'{"setl50":>6s} {"setl95":>6s} {"sFail":>5s} {"1stF":>4s}')
    P(hdr)
    P('-' * len(hdr))
    rep = dict(groups={}, buckets={}, acceptance={}, missing=missing, files=infos)

    def row(name, A):
        s = summarize(A)
        P(f'{name:22s} {s["files"]:5d} {s["eval_frames"]:6d} {f1(s["coverage_pct"], 1):>6s} {f1(s["median_abs_cents"]):>6s} '
          f'{f1(s["p95_abs_cents"]):>6s} {f1(s["max_abs_cents"], 1):>7s} {f1(s["right_note_pct"], 1):>6s} '
          f'{f1(s["target_ok_pct"], 1):>6s} {f1(s["status_ok_pct"], 1):>6s} {s["harmonic_errors"]:4d} {s["nothing_frames"]:6d} '
          f'{f1(s["false_reading_pct"], 1):>6s} {s["noisy_frames"]:5d} {s["wrong_tighten"]:5d} {s["wrong_loosen"]:5d} '
          f'{f1(s["settle_median_ms"], 0):>6s} {f1(s["settle_p95_ms"], 0):>6s} '
          f'{(str(s["settle_fail"]) + "/" + str(s["settle_budgeted"])) if s["settle_budgeted"] else "-":>5s} '
          f'{f1(s["first_correct_frames_median"], 0):>4s}')
        return s
    for g in sorted(groups):
        rep['groups'][g] = row(g, groups[g])
    P('')
    for b in sorted(buckets):
        rep['buckets'][b] = row(b, buckets[b])
    if a5.files:
        rep['buckets']['A5-decay'] = row('A5-decay(E1,B0,E2)', a5)
    if allb.files:
        rep['buckets']['R:all-base'] = row('R:all-base', allb)
    P('')
    P('Columns: evalF = frames inside evaluation windows; cover% = of those, frames showing a reading; med/p95/max = |cents|'
      ' error of shown frames vs truth; note% = right note (octave included) among shown frames; tgt% = engine target'
      ' string = expected; stat% = status in the expected set; harm = shown frames off by 7/12/19/24 semitones;'
      ' nothF = frames where nothing must be shown (after grace); false% = of those, frames showing a reading;'
      ' noisy = frames with status noisy in nothing-segments; wDirT/wDirL = "tighten" while sharp / "loosen" while flat'
      ' (> tolerance+2 c); setl50/95 = settle ms (onset -> stable within +-2 c); sFail = settle over SPEC budget/budgeted'
      ' onsets; 1stF = median frames from onset to first right-note reading.')
    P('')
    # ---------------- acceptance vs SPEC
    acc = rep['acceptance']

    def bget(k):
        return rep['buckets'].get(k)

    def verdict(ok):
        return 'PASS' if ok else 'FAIL'
    P('REAL recordings - REPORTED, NOT an acceptance verdict (SPEC 13.2: real-recording numbers are reported')
    P('separately with their reference uncertainty and never mixed into the synthetic A2 cents figure).')
    P('The A1 limits are printed only as a yardstick; "ref_u" = median / p95 reference uncertainty of the truth itself.')
    for key, med_lim, p95_lim, label in (('R:steady_harmonic', 0.5, 1.0, 'bowed/wind 40-1000 Hz, no vibrato'),
                                         ('R:pluck_first_partial', None, 1.5, 'pizzicato 40-1000 Hz vs first partial'),
                                         ('R:piano_first_partial', None, 1.5, 'piano vs first partial (strong inharmonicity)'),
                                         ('R:high_1000_2100', None, 2.0, '1000-2100 Hz'),
                                         ('R:low_below_40', None, 2.0, '< 40 Hz'),
                                         ('R:vibrato', None, None, 'vibrato, lookback rule'),
                                         ('R:all-base', None, None, 'all base files')):
        s = bget(key)
        if not s or s['median_abs_cents'] is None:
            P(f'  {key:24s} no data')
            continue
        within = (med_lim is None or s['median_abs_cents'] <= med_lim) and (p95_lim is None or s['p95_abs_cents'] <= p95_lim)
        yard = '' if p95_lim is None else f'  [{"within" if within else "outside"} the A1 yardstick: median <= {med_lim or "-"}, p95 <= {p95_lim}]'
        acc[key] = dict(median=s['median_abs_cents'], p95=s['p95_abs_cents'], coverage_pct=s['coverage_pct'],
                        right_note_pct=s['right_note_pct'], ref_u_median=s['ref_u_median_cents'], ref_u_p95=s['ref_u_p95_cents'],
                        files=s['files'], within_a1_yardstick=within if p95_lim is not None else None)
        P(f'  {key:24s} files {s["files"]:3d}  median {f1(s["median_abs_cents"], 3)} c, p95 {f1(s["p95_abs_cents"], 3)} c, '
          f'max {f1(s["max_abs_cents"], 1)} c, coverage {f1(s["coverage_pct"], 1)} %, right note {f1(s["right_note_pct"], 2)} %, '
          f'ref_u {f1(s["ref_u_median_cents"], 2)}/{f1(s["ref_u_p95_cents"], 2)} c, period-vs-first-partial gap '
          f'{f1(s["period_gap_median_cents"], 2)}/{f1(s["period_gap_p95_cents"], 2)} c  ({label}){yard}')
    s = bget('A3:snr20plus')
    if s and s['right_note_pct'] is not None:
        acc['A3:snr20plus'] = dict(right_note_pct=s['right_note_pct'], coverage_pct=s['coverage_pct'])
        P(f'  {"A3-like right note":24s} {f1(s["right_note_pct"], 2)} % of shown frames (octave included; A3 yardstick 99.5 %), '
          f'coverage {f1(s["coverage_pct"], 1)} %')
    nf = sum(g['nothing_frames'] for g in rep['groups'].values())
    nfa = sum(g['false_reading_frames'] for g in rep['groups'].values())
    acc['nothing'] = dict(frames=nf, false_frames=nfa)
    P(f'  {"silence (pre-roll/after)":24s} {nfa}/{nf} frames show a reading ({f1(rate(nfa, nf), 2)} %) on room-noise or digital-silence segments')
    if 'harmonic' in rep['groups']:
        s = rep['groups']['harmonic']
        acc['harmonic'] = dict(frames=s['harmonic_frames'], ok_pct=s['harmonic_ok_pct'], harmonic_pct=s['harmonic_status_pct'])
        P(f'  {"harmonic-test files":24s} {s["files"]} files: {f1(s["harmonic_ok_pct"], 1)} % of shown frames have status harmonic '
          f'or muchTooHigh ({f1(s["harmonic_status_pct"], 1)} % harmonic), {s["harmonic_frames"]} frames; note right '
          f'{f1(s["right_note_pct"], 1)} %')
    ok = len(gacc['a4_viol']) == 0
    acc['A4'] = dict(verdict=verdict(ok), frames=gacc['a4_frames'], violations=len(gacc['a4_viol']),
                     examples=gacc['a4_viol'][:10])
    P(f'  {"A4 safety":24s} {verdict(ok)}  {len(gacc["a4_viol"])} "tighten" frames while >= 1 octave sharp of the target '
      f'({gacc["a4_frames"]} shown frames on such notes)' + (f'; e.g. {gacc["a4_viol"][:3]}' if gacc['a4_viol'] else ''))
    P(f'  {"SPEC 9 guard":24s} {verdict(not gacc["tighten_above_300"])}  {len(gacc["tighten_above_300"])} "tighten" frames '
      f'while > 300 c above the engine\'s own target (all files)'
      + (f'; e.g. {gacc["tighten_above_300"][:3]}' if gacc['tighten_above_300'] else ''))
    tot_wt = sum(g['wrong_tighten'] for g in rep['groups'].values())
    tot_wl = sum(g['wrong_loosen'] for g in rep['groups'].values())
    tot_df = sum(g['direction_frames'] for g in rep['groups'].values())
    acc['direction'] = dict(wrong_tighten=tot_wt, wrong_loosen=tot_wl, frames=tot_df)
    P(f'  {"wrong direction":24s} {verdict(tot_wt == 0 and tot_wl == 0)}  {tot_wt} "tighten" while sharp, {tot_wl} '
      f'"loosen" while flat, of {tot_df} flat/sharp frames (all files; vs the measured local truth)')
    sb = [(i['file'], o) for i in infos for o in i['onsets'] if o['budget_ms'] is not None]
    fails = [(f, o) for f, o in sb if o['settle_ms'] is None or o['settle_ms'] > o['budget_ms']]
    acc['settle'] = dict(onsets=len(sb), fails=len(fails))
    P(f'  {"settle (plucks)":24s} {len(sb) - len(fails)}/{len(sb)} budgeted pizzicato/piano onsets reach a stable reading within '
      f'+-2 c of the local truth inside 150 ms (82-1000 Hz) / 300 ms (< 70 Hz) - reported; owner target p95 200/400 ms (D36)')
    if allb.files:
        s = rep['buckets']['R:all-base']
        flips = s['harmonic_errors'] + s['tail_harmonic_errors']
        acc['octave_flips'] = dict(harmonic_frames=flips)
        P(f'  {"octave/harmonic errors":24s} {flips} shown frames off by 7/12/19/24 semitones on base files (evaluation window + tail)')
    jumps = [(g, s['steady_display_jump_max'], s['steady_display_jump_viol']) for g, s in rep['groups'].items()
             if s['steady_display_jump_max'] > 0 or s['steady_display_jump_viol']]
    viol = sum(j[2] for j in jumps)
    acc['steady_display'] = dict(violations=viol)
    P(f'  {"steady display":24s} {viol} consecutive-frame displayCents changes > 1 on notes flagged steady '
      f'(pitch spread <= 3 c)' + (f' (max {max(j[1] for j in jumps):.1f})' if jumps else ''))
    # worst files
    P('')
    P('Files needing a look (settle failures, wrong notes, false readings, wrong direction):')
    flagged = 0
    for f, o in fails[:25]:
        P(f'  settle {f}: onset {o["t0"]} s {o["note"]}: settle {f1(o["settle_ms"], 0)} ms (budget {o["budget_ms"]})')
        flagged += 1
    if len(fails) > 25:
        P(f'  ... {len(fails) - 25} more settle failures')
    rows = []
    for i in infos:
        s = i['summary']
        wrong = (s['eval_frames'] and s['right_note_pct'] is not None and s['right_note_pct'] < 99.0)
        if wrong or s['false_reading_frames'] or s['wrong_tighten'] or s['wrong_loosen'] or \
                (s['coverage_pct'] is not None and s['coverage_pct'] < 80) or \
                (s['p95_abs_cents'] is not None and s['p95_abs_cents'] > 3):
            rows.append(i)
    rows.sort(key=lambda i: -((i['summary']['wrong_tighten'] + i['summary']['wrong_loosen']) * 1000
                              + i['summary']['false_reading_frames'] * 10
                              + (100 - (i['summary']['right_note_pct'] or 100))))
    lim = None if '--all' in sys.argv else 40
    for i in rows[:lim]:
        s = i['summary']
        P(f'  {i["file"]}: cover {f1(s["coverage_pct"], 0)} %, note {f1(s["right_note_pct"], 1)} %, p95 '
          f'{f1(s["p95_abs_cents"], 2)} c, max {f1(s["max_abs_cents"], 1)} c, false {s["false_reading_frames"]}, '
          f'wrongDir {s["wrong_tighten"]}/{s["wrong_loosen"]}')
    if lim and len(rows) > 40:
        P(f'  ... {len(rows) - 40} more files flagged (see --json)')
    if missing:
        P(f'  missing outputs ({len(missing)}): ' + ', '.join(missing[:10]) + (' ...' if len(missing) > 10 else ''))
    P('Per-file detail: python3 check.py OUTPUTS --file <name>')
    jp = arg('--json')
    if jp:
        with open(jp, 'w') as fh:
            json.dump(rep, fh, indent=1, default=str)
        P(f'JSON report written to {jp}')


if __name__ == '__main__':
    main()
