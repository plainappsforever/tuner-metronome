// Fix round 3 regression tests: files of the real-recording set 1 (test/blind/real-1, University of Iowa MIS excerpts,
// measured once on ec0bc99; a TUNING set since fix round 3) for the misses of that measurement. Only the WAVs used here
// are committed (`.gitignore` exceptions, D38); each is verified against the set's MANIFEST.sha256 before use. Metrics
// follow the set's checker (check.py, FORMAT.md): a frame "shows a reading" when its status is flat/sharp/inTune/
// muchTooHigh/veryLow/harmonic and it is not held; the truth at a frame is the mean of the measured first-partial curve
// over the engine's window ending at the frame (4096 samples, 8192 for notes or instruments below 70 Hz, doubled at
// ≥ 88.2 kHz); evaluation frames run from `eval_from` to `t1`. Bounds sit just above the values measured after the
// round; the ec0bc99 value is in each comment.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runOffline } from './stream';
import type { TunerState } from './tracker';

const SET = join(__dirname, '../../../test/blind/real-1');
const SHOWN = new Set(['flat', 'sharp', 'inTune', 'muchTooHigh', 'veryLow', 'harmonic']);
const TIGHTEN = new Set(['flat', 'veryLow']);

type Reading = {
  expect: string;
  t0: number;
  t1: number;
  hz: number;
  midi: number;
  eval_from: number;
  hz_curve: [number, number][];
  cents_vs_target: number | null;
  target_midi: number | null;
  steady?: boolean;
  onset?: boolean;
};
type Segment = { expect: string; t0: number; t1: number; truth_of?: number } & Partial<Reading>;
type Truth = { file: string; sampleRate: number; targets: number[] | null; segments: Segment[] };

const sets = {
  main: { dir: SET, truth: JSON.parse(readFileSync(join(SET, 'truth.json'), 'utf8')).files as Truth[], prefix: '' },
  supp: { dir: join(SET, 'supplement'), truth: JSON.parse(readFileSync(join(SET, 'supplement/truth.json'), 'utf8')).files as Truth[], prefix: 'supplement/' },
};
const commands = (dir: string) =>
  new Map(
    readFileSync(join(dir, 'commands.tsv'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t') as [string, string]),
  );
const manifest = new Map(
  readFileSync(join(SET, 'MANIFEST.sha256'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, name] = l.split(/\s+\*?/);
      return [name, hash] as [string, string];
    }),
);

/** 16/24-bit PCM and 32-bit float WAV, mono. */
function readWav(buf: Buffer): { samples: Float32Array; sr: number } {
  let at = 12;
  let fmt: { format: number; rate: number; bits: number } | null = null;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
      if (fmt.format === 0xfffe) fmt.format = buf.readUInt16LE(body + 24);
    } else if (id === 'data' && fmt) {
      const bytes = fmt.bits / 8;
      const n = Math.floor(size / bytes);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = body + bytes * i;
        out[i] = fmt.format === 3 ? buf.readFloatLE(o) : fmt.bits === 24 ? buf.readIntLE(o, 3) / 8388608 : buf.readInt16LE(o) / 32768;
      }
      return { samples: out, sr: fmt.rate };
    }
    at = body + size + (size % 2);
  }
  throw new Error('no data chunk');
}

const cents = (a: number, b: number) => 1200 * Math.log2(a / b);
const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const quantile = (v: number[], q: number) => {
  const s = [...v].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] : NaN;
};

type Result = {
  states: TunerState[];
  /** Shown evaluation frames / evaluation frames. */
  coverage: number;
  /** Shown evaluation frames within 50 c of the truth (right note and octave). */
  rightNote: number;
  medErr: number;
  p95Err: number;
  /** Held (greyed) evaluation frames / evaluation frames. */
  held: number;
  /** "Tighten" frames (reading or tail) on a note ≥ 1 octave above the target (A4 safety). */
  a4: number;
  /** Shown evaluation frames whose string is not the truth's target string (instrument auto/locked mode). */
  wrongString: number;
  settleMs: number | null;
  displayJumps: number;
  /** Shown frames in the 1.5 s after `t1` (the note's tail) read ≥ 600 c from the note (an octave or a 12th off). */
  tailOff: number;
};

function run(prefix: string, set: 'main' | 'supp' = 'main'): Result {
  const S = sets[set];
  const tf = S.truth.find((t) => t.file.startsWith(prefix));
  if (!tf) throw new Error(`no truth for ${prefix}`);
  const buf = readFileSync(join(S.dir, tf.file));
  expect(createHash('sha256').update(buf).digest('hex')).toBe(manifest.get(S.prefix + tf.file)); // the set's file, unchanged
  const { samples, sr } = readWav(buf);
  const args = (commands(S.dir).get(tf.file) ?? '').split(/\s+/).filter(Boolean);
  const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const targets = (opt('--targets') ?? '').split(',').filter(Boolean).map(Number);
  const locked = opt('--locked');
  const states = runOffline(samples, sr, { a4: 440, targets, locked: locked === undefined ? null : Number(locked), tolerance: 3 });
  const rd = tf.segments.find((g) => g.expect === 'reading') as Reading;
  const low = rd.hz < 70 || (targets.length > 0 && Math.min(...targets.map(midiHz)) < 70);
  const win = ((low ? 8192 : 4096) * (sr >= 88200 ? 2 : 1)) / sr;
  const truthAt = (t: number) => {
    const v = rd.hz_curve.filter(([ct]) => ct >= t - win && ct <= t).map(([, h]) => h);
    if (v.length) return v.reduce((a, b) => a + b, 0) / v.length;
    return rd.hz_curve.reduce((b, p) => (Math.abs(p[0] - (t - win / 2)) < Math.abs(b[0] - (t - win / 2)) ? p : b))[1];
  };
  const errs: number[] = [];
  let evalN = 0;
  let shownN = 0;
  let right = 0;
  let held = 0;
  let a4 = 0;
  let wrongString = 0;
  let settleMs: number | null = null;
  let displayJumps = 0;
  let prev: { i: number; d: number } | null = null;
  let tailOff = 0;
  const last = rd.hz_curve[rd.hz_curve.length - 1][1];
  states.forEach((s, i) => {
    const shown = SHOWN.has(s.status) && !s.held;
    const inNote = s.t >= rd.t0;
    const seg = tf.segments.find((g) => g.t0 <= s.t && s.t < g.t1) ?? tf.segments[tf.segments.length - 1];
    if (inNote && seg.expect !== 'nothing' && shown && TIGHTEN.has(s.status) && (rd.cents_vs_target ?? 0) >= 1160) a4++;
    if (s.t > rd.t1 && s.t <= rd.t1 + 1.5 && shown && s.hz !== null && Math.abs(cents(s.hz, last)) >= 600) tailOff++;
    if (s.t < rd.t0 || s.t > rd.t1) return;
    const err = shown && s.hz !== null ? cents(s.hz, truthAt(s.t)) : null;
    if (settleMs === null && shown && s.stable && err !== null && Math.abs(err) <= 2) settleMs = Math.round((s.t - rd.t0) * 1000);
    if (s.t < rd.eval_from) return;
    evalN++;
    if (s.held) held++;
    if (shown && err !== null) {
      shownN++;
      errs.push(Math.abs(err));
      if (Math.abs(err) < 50) right++;
      if (rd.target_midi !== null && s.targetMidi !== null && s.status !== 'harmonic' && s.targetMidi !== rd.target_midi) wrongString++;
    }
    if (rd.steady && shown && s.displayCents !== null) {
      if (prev && prev.i === i - 1 && Math.abs(s.displayCents - prev.d) > 1) displayJumps++;
      prev = { i, d: s.displayCents };
    } else prev = null;
  });
  return {
    states,
    coverage: evalN ? shownN / evalN : 0,
    rightNote: shownN ? right / shownN : 0,
    medErr: quantile(errs, 0.5),
    p95Err: quantile(errs, 0.95),
    held: evalN ? held / evalN : 0,
    a4,
    wrongString,
    settleMs,
    displayJumps,
    tailOff,
  };
}

describe('real-recording set 1 regressions (fix round 3; tuning set since this round)', () => {
  it('miss 1 — octave decision: a real low note whose upper partials dominate is read at its own octave (164, 030)', () => {
    // 164 double-bass arco G1 ff, chromatic. ec0bc99: right note 0 % (G2 for the whole note: MPM took the 2nd partial,
    // then a comb at "50 Hz" kept it), coverage 78 %, never settled.
    const g1 = run('164_');
    expect(g1.rightNote).toBe(1);
    expect(g1.coverage).toBe(1);
    expect(g1.medErr).toBeLessThan(1.2);
    expect(g1.settleMs).not.toBeNull();
    // Supplement 030 double-bass arco G♯1 in auto mode. ec0bc99: G♯2 for the whole note — "G string +86 c, loosen"
    // (54 evaluation frames on the wrong string).
    const gs1 = run('030_', 'supp');
    expect(gs1.rightNote).toBe(1);
    expect(gs1.wrongString).toBe(0);
    expect(gs1.p95Err).toBeLessThan(5);
  });

  it('miss 2 — oboe: a strong 3rd partial is not the note; a second onset inside one attack takes no residual (131)', () => {
    // 131 oboe A♯4. ec0bc99: right note 0 % (F6, the 3rd partial: MPM's pick, then the comb at the re-tongued note's own
    // pitch left its 3rd partial over).
    const r = run('131_');
    expect(r.rightNote).toBe(1);
    expect(r.medErr).toBeLessThan(0.8);
    expect(r.settleMs as number).toBeLessThanOrEqual(200);
  });

  it('miss 3 — octave continuity: a fading fundamental never turns the note into its 2nd partial (179 viola C3, auto mode)', () => {
    // ec0bc99: from 3.0 s "C4 on the D string, −210 c" (36 frames, 2 inside the evaluation window).
    const r = run('179_');
    expect(r.rightNote).toBe(1);
    expect(r.wrongString).toBe(0);
    expect(r.tailOff).toBe(0);
  });

  it('miss 1 / A4 — locked mode: a sub-harmonic in the tail is taken back to the note, never "very low — tighten" (066)', () => {
    // Supplement 066 double-bass A2 harmonic on the locked A1 string. ec0bc99: 5 "veryLow" frames from a 27.35 Hz (A0)
    // reading in the tail — a genuine A4 failure.
    const r = run('066_', 'supp');
    expect(r.a4).toBe(0);
    expect(r.tailOff).toBe(0);
    expect(r.rightNote).toBe(1);
  });

  it('miss 1 — the comb is not applied at a pizzicato\'s own gliding attack pitch (065 double-bass A2)', () => {
    // Supplement 065. ec0bc99: right note 72 % (A1 from the residual of a second onset 0.13 s into the attack), coverage
    // 82 %; the round's intermediate version read A1 for the whole note.
    const r = run('065_', 'supp');
    expect(r.rightNote).toBe(1);
    expect(r.coverage).toBe(1);
    expect(r.wrongString).toBe(0);
  });

  it('miss 1 — an attack read an octave high corrects itself while the note is young (186 violin pizz G3, auto mode)', () => {
    // Supplement 186. ec0bc99: right note 0 % (G4 for the whole note, 21 frames on the wrong string).
    const r = run('186_', 'supp');
    expect(r.rightNote).toBe(1);
    expect(r.wrongString).toBe(0);
    expect(r.coverage).toBe(1);
  });

  it('misses 5/6 — partials 1–8 fit: plucked, bowed and low piano notes read their first partial (063, 053, 151)', () => {
    // ec0bc99 median |error|: 063 cello pizz C2 10.8 c (p95 18.5), 053 cello arco D3 8.3 c, 151 piano A2 7.2 c (4 steady-
    // display jumps > 1 c, never settled).
    const pizz = run('063_');
    expect(pizz.medErr).toBeLessThan(5);
    expect(pizz.p95Err).toBeLessThan(8.5);
    const arco = run('053_');
    expect(arco.medErr).toBeLessThan(2.5);
    expect(arco.p95Err).toBeLessThan(6);
    const piano = run('151_');
    expect(piano.medErr).toBeLessThan(0.8);
    expect(piano.p95Err).toBeLessThan(1.5);
    expect(piano.displayJumps).toBe(0);
    expect(piano.settleMs as number).toBeLessThanOrEqual(200); // also: no second (novelty) onset 0.13 s into the attack
  });

  it('miss 7 — low-frequency handling noise under a ringing guitar string: the reading stays live (025 guitar F4)', () => {
    // Supplement 025. ec0bc99: held (greyed) on 41 % of the evaluation frames from ≈ 1.8 s while the string still rang.
    const r = run('025_', 'supp');
    expect(r.held).toBe(0);
    expect(r.coverage).toBe(1);
    expect(r.p95Err).toBeLessThan(0.6);
  });
});
