// Fix round 2 regression tests: one or more files of blind set 1 (test/blind/pitch-1, measured once on e55774b; a
// TUNING set since fix round 2) for every miss of that measurement. The 13 WAVs used here are committed (16-bit, 3.8 MB,
// the exception to D28 noted in D37); their checksums are verified against the set's MANIFEST.sha256. Metrics follow
// the set's own checker (check.py, FORMAT.md): a frame "shows a reading" when its status is flat/sharp/inTune/
// muchTooHigh/veryLow and it is not held; accuracy frames are those of a reading segment from `eval_from` to `t1`.
// Each bound sits just above the value measured after the round; the e55774b value is in the comment.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runOffline } from './stream';
import type { TunerState } from './tracker';

const SET = join(__dirname, '../../../test/blind/pitch-1');
const SHOWN = new Set(['flat', 'sharp', 'inTune', 'muchTooHigh', 'veryLow']);

type Segment = {
  t0: number;
  t1: number;
  expect: 'reading' | 'nothing' | 'nothing_or_noisy' | 'dont_care';
  hz?: number;
  eval_from?: number;
  expected_status?: string[] | null;
  onset?: boolean;
  steady?: boolean;
  octave_ambiguous?: boolean;
};
type Truth = { file: string; a4: number; tolerance_cents: number; segments: Segment[] };

const truth: Truth[] = JSON.parse(readFileSync(join(SET, 'truth.json'), 'utf8')).files;
const commands = new Map(
  readFileSync(join(SET, 'commands.tsv'), 'utf8')
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

function readWav(buf: Buffer): { samples: Float32Array; sr: number } {
  let at = 12;
  let fmt: { format: number; rate: number; bits: number } | null = null;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (id === 'data' && fmt) {
      const n = size / (fmt.bits / 8);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = fmt.format === 3 ? buf.readFloatLE(body + 4 * i) : buf.readInt16LE(body + 2 * i) / 32768;
      return { samples: out, sr: fmt.rate };
    }
    at = body + size + (size % 2);
  }
  throw new Error('no data chunk');
}

const cents = (a: number, b: number) => 1200 * Math.log2(a / b);
const midiHz = (m: number, a4: number) => a4 * Math.pow(2, (m - 69) / 12);

type Result = {
  states: TunerState[];
  coverage: number;
  maxErr: number;
  statusOk: number;
  falseShown: number;
  nothingFrames: number;
  settleMs: (number | null)[];
  displayJumps: number;
  /** Checker rule: "tighten" while > tol+2 c sharp of the frame's target, "loosen" while that flat (truth as given). */
  wrongDirection: number;
  /** The same with the truth taken modulo an octave (octave-ambiguous tones: C4 or C5 accepted, as for the note). */
  wrongDirectionOctave: number;
};

function run(prefix: string): Result {
  const tf = truth.find((t) => t.file.startsWith(prefix));
  if (!tf) throw new Error(`no truth for ${prefix}`);
  const buf = readFileSync(join(SET, tf.file));
  expect(createHash('sha256').update(buf).digest('hex')).toBe(manifest.get(tf.file)); // the blind fixture, unchanged
  const { samples, sr } = readWav(buf);
  const args = (commands.get(tf.file) ?? '').split(/\s+/).filter(Boolean);
  const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const targets = (opt('--targets') ?? '').split(',').filter(Boolean).map(Number);
  const locked = opt('--locked');
  const states = runOffline(samples, sr, { a4: Number(opt('--a4') ?? 440), targets, locked: locked === undefined ? null : Number(locked), tolerance: Number(opt('--tolerance') ?? 3) });
  const tol = tf.tolerance_cents;
  const r: Result = { states, coverage: 0, maxErr: 0, statusOk: 0, falseShown: 0, nothingFrames: 0, settleMs: [], displayJumps: 0, wrongDirection: 0, wrongDirectionOctave: 0 };
  let evalFrames = 0;
  let shownEval = 0;
  let statN = 0;
  let statOk = 0;
  let prevDisplay: { i: number; d: number } | null = null;
  const settle = new Map<Segment, number | null>();
  states.forEach((s, i) => {
    const seg = tf.segments.find((g) => g.t0 <= s.t && s.t < g.t1) ?? tf.segments[tf.segments.length - 1];
    const shown = SHOWN.has(s.status) && !s.held;
    if (seg.expect === 'nothing' || seg.expect === 'nothing_or_noisy') {
      r.nothingFrames++;
      if (shown) r.falseShown++;
      prevDisplay = null;
      return;
    }
    if (seg.expect !== 'reading' || seg.hz === undefined) return;
    let err = shown && s.hz !== null ? cents(s.hz, seg.hz) : null;
    if (err !== null && seg.octave_ambiguous) err -= 1200 * Math.round(err / 1200);
    if (shown && (s.status === 'flat' || s.status === 'veryLow' || s.status === 'sharp' || s.status === 'muchTooHigh') && s.targetMidi !== null) {
      const c = cents(seg.hz, midiHz(s.targetMidi, tf.a4));
      const co = c - 1200 * Math.round(c / 1200);
      const tighten = s.status === 'flat' || s.status === 'veryLow';
      if (tighten ? c > tol + 2 : c < -(tol + 2)) r.wrongDirection++;
      if (tighten ? co > tol + 2 : co < -(tol + 2)) r.wrongDirectionOctave++;
    }
    if (seg.onset && !settle.has(seg)) settle.set(seg, null);
    if (seg.onset && settle.get(seg) === null && shown && s.stable && err !== null && Math.abs(err) <= 2) settle.set(seg, Math.round((s.t - seg.t0) * 1000));
    if (s.t < (seg.eval_from ?? seg.t0)) return;
    evalFrames++;
    if (shown) {
      shownEval++;
      if (err !== null) r.maxErr = Math.max(r.maxErr, Math.abs(err));
      if (seg.expected_status) {
        statN++;
        if (seg.expected_status.includes(s.status)) statOk++;
      }
    }
    if (seg.steady && shown && s.displayCents !== null) {
      if (prevDisplay && prevDisplay.i === i - 1 && Math.abs(s.displayCents - prevDisplay.d) > 1) r.displayJumps++;
      prevDisplay = { i, d: s.displayCents };
    } else prevDisplay = null;
  });
  r.coverage = evalFrames ? shownEval / evalFrames : 0;
  r.statusOk = statN ? statOk / statN : 1;
  r.settleMs = [...settle.values()];
  return r;
}

describe('blind set 1 regressions (fix round 2; tuning set since this round)', () => {
  it('miss 4 — metronome clicks over a note are not notes and do not reset it (337, 341)', () => {
    // 337 cello A3 + woodblock 100 BPM, e55774b: coverage 96.9 %, max 2619 c (the click read as a note), status 74.6 %.
    const a = run('337_');
    expect(a.coverage).toBe(1);
    expect(a.maxErr).toBeLessThan(0.5);
    expect(a.statusOk).toBeGreaterThan(0.97);
    // 341 E4 + woodblock 16ths at 120 BPM, e55774b: coverage 43.3 %, status 37.9 % (every click re-started the note).
    const b = run('341_');
    expect(b.coverage).toBe(1);
    expect(b.statusOk).toBeGreaterThan(0.99);
    expect(b.maxErr).toBeLessThan(0.5);
  });

  it('miss 7 (sympathetic) — the primary note is read; the second string sounding alone before it is a reading (decision D37)', () => {
    // 399 A2 with E2 plucked at −38 dBFS 0.3 s earlier: the checker's 47 % "false" frames are the E2 string sounding
    // ALONE in the pre-roll (no other sound). A real string at −38 dBFS is a reading; hiding it would hide soft plucks.
    const r = run('399_');
    expect(r.coverage).toBe(1);
    expect(r.maxErr).toBeLessThan(1);
    expect(r.statusOk).toBe(1);
    const pre = r.states.filter((s) => s.t >= 0.3 && s.t < 0.5 && SHOWN.has(s.status) && !s.held);
    expect(pre.length).toBeGreaterThan(0);
    expect(pre.every((s) => s.noteMidi === 40)).toBe(true); // E2 — what sounds
  });

  it('miss 5 — a note under mains hum is shown with its status (320 E2 over 50 Hz, 323 A1 over 60 Hz, SNR 10)', () => {
    // e55774b: 320 coverage 76 %, max 55.8 c, status 0 %, never settled; 323 coverage 90 %, max 12.3 c, status 0 %.
    for (const id of ['320_', '323_']) {
      const r = run(id);
      expect(r.coverage).toBe(1);
      expect(r.maxErr).toBeLessThan(0.5);
      expect(r.statusOk).toBeGreaterThan(0.95);
      expect(r.falseShown).toBe(0); // the 2.5 s of hum alone before the note
      expect(r.settleMs[0]).not.toBeNull();
    }
  });

  it('miss 1 — settle within the accepted 200 ms on the plucks that took 233 ms (038 bass G2 phone mic, 346 D3 → G3)', () => {
    expect(run('038_').settleMs[0]).toBeLessThanOrEqual(200); // e55774b 233 ms
    const sc = run('346_');
    expect(sc.settleMs.every((ms) => ms !== null && ms <= 200)).toBe(true); // e55774b 200 / 200 (the deferred onset)
    expect(sc.maxErr).toBeLessThan(0.5);
  });

  it('miss 9 — steady display: no jump > 1 c between frames while a steady note sustains (148 tuba D1, 155 D1)', () => {
    // e55774b: 2 jumps (max 5 c) and 1 jump (3 c) — a +40 c short-window estimate sliding out through the smoothing.
    for (const id of ['148_', '155_']) {
      const r = run(id);
      expect(r.displayJumps).toBe(0);
      expect(r.maxErr).toBeLessThan(1);
    }
  });

  it('miss 9 — wrong direction: none once the octave-ambiguous truth is read like the note (375)', () => {
    // 375 C4 with only even harmonics and a weak 3rd: the engine reads C5 (accepted by the checker for the note). e55774b:
    // 2 "loosen" frames by the checker's rule, which compares the direction with C4; now 1 — an unconfirmed "sharp" at
    // +0.00 c against C5. Against C4-or-C5 there is no wrong direction.
    const r = run('375_');
    expect(r.wrongDirectionOctave).toBe(0);
    expect(r.wrongDirection).toBeLessThanOrEqual(1);
  });

  it('miss 6 — low B with strong inharmonicity under a phone-mic roll-off is read (044, 046)', () => {
    // e55774b: 044 coverage 81 %, max 38.2 c, settle 1000 ms; 046 (B = 2e-3) coverage 0 % (clarity 0.65 never opened).
    for (const id of ['044_', '046_']) {
      const r = run(id);
      expect(r.coverage).toBeGreaterThan(0.97);
      expect(r.maxErr).toBeLessThan(2);
      expect(r.settleMs[0]).not.toBeNull();
      expect(r.settleMs[0] as number).toBeLessThanOrEqual(400);
    }
  });

  it('miss 8 — 10 dB SNR: "in tune" holds in room noise (292 clarinet D3)', () => {
    // e55774b: status 86.7 %, settle 333 ms (four estimates within ±3 c rarely lined up in noise).
    const r = run('292_');
    expect(r.statusOk).toBeGreaterThan(0.95);
    expect(r.settleMs[0] as number).toBeLessThanOrEqual(250);
  });
});
