// Referee for the pitch engine on the synthetic TUNING SET (test/fixtures/synth.ts). It measures what the user would
// see (tracker output) and the raw detector, per SPEC §12 A1/A3/A4/A5. These figures are tuning-set figures, not
// evidence on unseen material (L27 rule 4); the blind set of a separate agent provides that (P4).
import { PitchDetector } from '../src/engine/pitch/detect';
import { runOffline } from '../src/engine/pitch/stream';
import type { TrackerConfig, TunerState } from '../src/engine/pitch/tracker';
import { longDecays, safetySet, sequenceSet, tuningSet, type Fixture } from './fixtures/synth';

export type FixtureResult = {
  id: string;
  kind: Fixture['kind'];
  sr: number;
  hz: number | null;
  snrDb?: number;
  inharmonicity?: number;
  /** |cents error| of the displayed (smoothed) reading on frames after it settled, within [onset, end]. */
  errors: number[];
  /** |cents error| on EVERY shown frame within [onset, end], attack included (review S9 b). */
  allErrors: number[];
  /** Frames in [onset + coverFrom, end] (sequences: the newest note's window) and how many showed it, live, on its string. */
  coverFrames: number;
  covered: number;
  /** |cents error| of the raw detector on windows fully inside [onset, end] (fixed 4096/8192 window). */
  rawErrors: number[];
  /** Frames inside [onset, end] that showed a reading (not held). */
  shown: number;
  /** …of which within 50 cents of the truth (right note, right octave). */
  correct: number;
  /** Frames inside [onset, end] in total (after the first full window). */
  frames: number;
  /** Frames anywhere in a note-less file that showed a reading. */
  falseShown: number;
  /** Seconds from the onset to a stable reading within ±2 cents that stays there for 0.5 s (null = never). */
  settleS: number | null;
  /** Analysis frames from the onset to the first right-note reading (null = never). */
  latencyFrames: number | null;
  /** Frames showing a reading ≥ 600 cents off (octave/fifth errors) after the first reading. */
  octaveErrors: number;
  /** Largest change of the integer display between consecutive shown frames after settling. */
  maxDisplayStep: number;
  /**
   * A4 (SPEC §12): frames with status 'flat' ("tighten") while the PLAYED note — the fixture's truth, never the
   * reading — is ≥ 1 octave (−50 cents) above the target. Review M4/S9 a: this used to compare the folded reading.
   */
  unsafe: number;
  /** Stricter: 'flat' while the played note is ≥ 50 cents above the target (any distance). */
  unsafeSharp: number;
  /** Status counts over shown frames in [onset, end]. */
  statuses: Record<string, number>;
};

const cents = (hz: number, truth: number) => 1200 * Math.log2(hz / truth);

export function runFixture(f: Fixture, config?: Partial<TrackerConfig>): FixtureResult {
  const hop = Math.round(f.sr / 30);
  const cfg: TrackerConfig = {
    a4: f.a4,
    targets: f.strings ?? [],
    locked: f.locked ?? null,
    tolerance: 3,
    ...config,
  };
  const states: TunerState[] = runOffline(f.samples, f.sr, cfg, hop);
  const res: FixtureResult = {
    id: f.id,
    kind: f.kind,
    sr: f.sr,
    hz: f.hz,
    snrDb: f.snrDb,
    inharmonicity: f.inharmonicity,
    errors: [],
    rawErrors: [],
    shown: 0,
    correct: 0,
    frames: 0,
    falseShown: 0,
    settleS: null,
    latencyFrames: null,
    octaveErrors: 0,
    maxDisplayStep: 0,
    unsafe: 0,
    unsafeSharp: 0,
    allErrors: [],
    coverFrames: 0,
    covered: 0,
    statuses: {},
  };
  const t0 = f.onset / f.sr;
  const tEnd = f.end / f.sr;
  const truthAt = (t: number) => (f.hzAt ? f.hzAt(t) : (f.hz as number));
  for (const s of states) {
    if (s.cents !== null && s.status === 'flat' && s.targetMidi !== null && s.hz !== null) {
      const target = cfg.a4 * Math.pow(2, (s.targetMidi - 69) / 12);
      // What was PLAYED: the fixture's truth (in a mixture: the sounding note nearest to the reading); in a note-less
      // file or before the note starts, the reading itself.
      const sounding = f.hz !== null && s.t > t0 ? [truthAt(s.t), ...(f.others ?? [])] : f.hz !== null && f.kind === 'nextString' ? (f.others ?? []) : [];
      const played = sounding.length ? sounding.reduce((a, b) => (Math.abs(cents(b, s.hz as number)) < Math.abs(cents(a, s.hz as number)) ? b : a)) : s.hz;
      const above = cents(played, target);
      if (above >= 1150) res.unsafe++;
      if (above >= 50) res.unsafeSharp++;
    }
  }
  if (f.hz === null) {
    res.falseShown = states.filter((s) => s.cents !== null && !s.held).length;
    res.frames = states.length;
    return res;
  }
  let firstShown = -1;
  let settledAt = -1;
  let prevDisplay: number | null = null;
  const frameIdx = states.map((s, i) => ({ s, i })).filter(({ s }) => s.t > t0 && s.t <= tEnd);
  for (let j = 0; j < frameIdx.length; j++) {
    const { s } = frameIdx[j];
    res.frames++;
    const inCover = s.t >= t0 + (f.coverFrom ?? 0.3);
    if (inCover) res.coverFrames++;
    if (s.cents === null || s.held || s.hz === null) {
      prevDisplay = null;
      continue;
    }
    res.shown++;
    res.statuses[s.status] = (res.statuses[s.status] ?? 0) + 1;
    const err = cents(s.hz, truthAt(s.t));
    res.allErrors.push(Math.abs(err));
    if (inCover && Math.abs(err) < 50 && (cfg.targets.length === 0 || f.midi === null || s.targetMidi === f.midi || f.kind === 'glideUp')) res.covered++;
    if (Math.abs(err) < 50) res.correct++;
    if (firstShown < 0) firstShown = j;
    if (Math.abs(err) >= 600) res.octaveErrors++;
    if (res.latencyFrames === null && Math.abs(err) < 50) res.latencyFrames = j + 1;
    if (settledAt < 0 && s.stable && Math.abs(err) <= 2) {
      // Must stay within ±2 cents for 0.5 s (or until the end of the scored part).
      const until = s.t + 0.5;
      const ok = frameIdx.slice(j).every(({ s: x }) => x.t > until || (x.hz !== null && !x.held && Math.abs(cents(x.hz, truthAt(x.t))) <= 2));
      if (ok) {
        settledAt = j;
        res.settleS = s.t - t0;
      }
    }
    if (f.kind === 'vibrato') {
      // Vibrato never becomes "stable" (±10 cents); scored against the centre frequency from 0.25 s after the onset.
      if (s.t >= t0 + 0.25) res.errors.push(Math.abs(cents(s.hz, f.hz as number)));
    } else if (settledAt >= 0) {
      res.errors.push(Math.abs(err));
      // Steps between two consecutive frames that are both settled (the step into the first settled frame is the
      // reading converging, not flicker).
      if (prevDisplay !== null && s.displayCents !== null && j > settledAt) res.maxDisplayStep = Math.max(res.maxDisplayStep, Math.abs(s.displayCents - prevDisplay));
    }
    prevDisplay = s.displayCents;
  }
  // Raw detector on full windows inside the note (single notes only: in sequences the window mixes notes).
  if (SEQUENCES.includes(f.kind)) return res;
  const det = new PitchDetector();
  const w = f.hz < 70 ? (f.sr > 46000 ? 8192 : 8192) : 4096;
  for (let e = f.onset + w; e <= f.end; e += hop) {
    const d = det.detect(f.samples.subarray(e - w, e), f.sr);
    if (d.hz) res.rawErrors.push(Math.abs(cents(d.hz, truthAt(((e - w / 2) / f.sr)))));
  }
  return res;
}

export const SEQUENCES: Fixture['kind'][] = ['nextString', 'pluckTrain', 'longRing', 'glideUp', 'bowedHumBand', 'bassPair'];

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

export type Group = { name: string; filter: (r: FixtureResult) => boolean };

const inRange = (lo: number, hi: number) => (r: FixtureResult) => r.hz !== null && r.hz >= lo && r.hz < hi;
const cleanEnough = (r: FixtureResult) => r.kind !== 'vibrato' && r.kind !== 'humUnder' && !SEQUENCES.includes(r.kind) && !(r.snrDb !== undefined && r.snrDb < 20);
const harmonicOrMild = (r: FixtureResult) => !(r.kind === 'pluck' && (r.inharmonicity ?? 0) > 5e-4);

export const GROUPS: Group[] = [
  { name: 'A1 40–1000 Hz, SNR ≥ 20 dB', filter: (r) => inRange(40, 1000)(r) && cleanEnough(r) && harmonicOrMild(r) },
  { name: 'A1 1000–2100 Hz', filter: (r) => inRange(1000, 2100)(r) && cleanEnough(r) },
  { name: 'A1 30–40 Hz', filter: (r) => inRange(30, 40)(r) && cleanEnough(r) },
  { name: 'A1 inharmonic plucks B ≤ 5e-4', filter: (r) => r.kind === 'pluck' && (r.inharmonicity ?? 0) <= 5e-4 && r.inharmonicity !== undefined },
  { name: 'pluck B = 1e-3 (beyond A1)', filter: (r) => r.kind === 'pluck' && r.inharmonicity === 1e-3 },
  { name: 'noise SNR 10 dB', filter: (r) => r.kind === 'noisy' && r.snrDb === 10 },
  { name: 'hum under note (10–20 dB)', filter: (r) => r.kind === 'humUnder' },
  { name: 'vibrato ±10 cents (vs centre)', filter: (r) => r.kind === 'vibrato' },
];

export type Summary = {
  fixtures: number;
  groups: { name: string; fixtures: number; frames: number; p50: number; p90: number; p95: number; p99: number; max: number; rawP50: number; rawP95: number; allFrames: number; allP50: number; allP95: number; allP99: number; allMax: number; coverage: number }[];
  /** Sequences (S9): per kind, share of frames in each fixture's window showing the newest note live on its string. */
  /** `unsafe` here = frames 'flat' while the played note is ≥ 50 cents above the target. */
  sequences: { kind: string; fixtures: number; coverage: number; worst: string; settledP95: number; allP95: number; unsafe: number; statuses: Record<string, number> }[];
  /** Long 4 s decays: share of frames in the last second showing a reading (review M1: was 0). */
  longDecayLastSecondShown: number;
  noteCorrect20: number; // A3 share of shown frames with the right note at SNR ≥ 20 dB
  noteCorrect10: number;
  noteCorrectHumUnder: number; // hum 10–20 dB under a plucked note
  humShown: number; // frames showing a note in hum-alone files
  noiseShownShare: number; // share of frames showing a note in noise-only files
  clicksShownShare: number;
  unsafe: number;
  unsafeSharp: number;
  settle: { name: string; n: number; p50: number; p95: number; max: number; never: number }[];
  latencyFrames: { p50: number; p95: number; max: number };
  octaveFlipsLongDecay: number;
  maxDisplayStepSteady: number;
};

export function summarize(results: FixtureResult[]): Summary {
  const groups = GROUPS.map((g) => {
    const rs = results.filter(g.filter);
    const errs = rs.flatMap((r) => r.errors);
    const raw = rs.flatMap((r) => r.rawErrors);
    const all = rs.flatMap((r) => r.allErrors);
    return {
      allFrames: all.length,
      allP50: quantile(all, 0.5),
      allP95: quantile(all, 0.95),
      allP99: quantile(all, 0.99),
      allMax: quantile(all, 1),
      coverage: rs.reduce((a, r) => a + r.shown, 0) / Math.max(1, rs.reduce((a, r) => a + r.frames, 0)),
      name: g.name,
      fixtures: rs.length,
      frames: errs.length,
      p50: quantile(errs, 0.5),
      p90: quantile(errs, 0.9),
      p95: quantile(errs, 0.95),
      p99: quantile(errs, 0.99),
      max: quantile(errs, 1),
      rawP50: quantile(raw, 0.5),
      rawP95: quantile(raw, 0.95),
    };
  });
  const noted = results.filter((r) => r.hz !== null && r.kind !== 'longDecay' && r.kind !== 'safety' && !SEQUENCES.includes(r.kind));
  const share = (rs: FixtureResult[]) => rs.reduce((a, r) => a + r.correct, 0) / Math.max(1, rs.reduce((a, r) => a + r.shown, 0));
  const settleGroups = [
    { name: '82–1000 Hz (target ≤ 0.150 s)', f: (r: FixtureResult) => inRange(82, 1000)(r) },
    { name: '< 70 Hz (target ≤ 0.300 s)', f: (r: FixtureResult) => inRange(0, 70)(r) },
    { name: '70–82 Hz (reported, between the two targets)', f: (r: FixtureResult) => inRange(70, 82)(r) },
  ].map(({ name, f }) => {
    const rs = noted.filter((r) => f(r) && cleanEnough(r) && harmonicOrMild(r) && r.kind !== 'vibrato');
    const s = rs.map((r) => r.settleS).filter((x): x is number => x !== null);
    return { name, n: rs.length, p50: quantile(s, 0.5), p95: quantile(s, 0.95), max: quantile(s, 1), never: rs.length - s.length };
  });
  const lat = noted.map((r) => r.latencyFrames).filter((x): x is number => x !== null);
  const steady = results.filter((r) => r.kind === 'sine' || r.kind === 'harmonic' || r.kind === 'saw');
  const noise = results.filter((r) => r.kind === 'noiseAlone');
  const clicks = results.filter((r) => r.kind === 'clicksAlone');
  return {
    fixtures: results.length,
    groups,
    noteCorrect20: share(noted.filter((r) => r.snrDb === undefined || r.snrDb >= 20)),
    noteCorrect10: share(noted.filter((r) => r.snrDb === 10 && r.kind === 'noisy')),
    noteCorrectHumUnder: share(noted.filter((r) => r.kind === 'humUnder')),
    humShown: results.filter((r) => r.kind === 'humAlone').reduce((a, r) => a + r.falseShown, 0),
    noiseShownShare: noise.reduce((a, r) => a + r.falseShown, 0) / Math.max(1, noise.reduce((a, r) => a + r.frames, 0)),
    clicksShownShare: clicks.reduce((a, r) => a + r.falseShown, 0) / Math.max(1, clicks.reduce((a, r) => a + r.frames, 0)),
    unsafe: results.reduce((a, r) => a + r.unsafe, 0),
    unsafeSharp: results.reduce((a, r) => a + r.unsafeSharp, 0),
    settle: settleGroups,
    latencyFrames: { p50: quantile(lat, 0.5), p95: quantile(lat, 0.95), max: quantile(lat, 1) },
    octaveFlipsLongDecay: results.filter((r) => r.kind === 'longDecay').reduce((a, r) => a + r.octaveErrors, 0),
    longDecayLastSecondShown: lastSecond(results),
    sequences: SEQUENCES.map((kind) => {
      const rs = results.filter((r) => r.kind === kind);
      const worst = [...rs].sort((a, b) => a.covered / Math.max(1, a.coverFrames) - b.covered / Math.max(1, b.coverFrames))[0];
      const statuses: Record<string, number> = {};
      for (const r of rs) for (const [k, v] of Object.entries(r.statuses)) statuses[k] = (statuses[k] ?? 0) + v;
      return {
        kind,
        fixtures: rs.length,
        coverage: rs.reduce((a, r) => a + r.covered, 0) / Math.max(1, rs.reduce((a, r) => a + r.coverFrames, 0)),
        worst: worst ? `${worst.id} ${((100 * worst.covered) / Math.max(1, worst.coverFrames)).toFixed(0)} %` : '—',
        settledP95: quantile(rs.flatMap((r) => r.errors), 0.95),
        allP95: quantile(rs.flatMap((r) => r.allErrors), 0.95),
        unsafe: rs.reduce((a, r) => a + r.unsafeSharp, 0),
        statuses,
      };
    }),
    maxDisplayStepSteady: Math.max(0, ...steady.map((r) => r.maxDisplayStep)),
  };
}

const lastSecondShown = new Map<string, number>();
function lastSecond(results: FixtureResult[]): number {
  const ids = results.filter((r) => r.kind === 'longDecay').map((r) => r.id);
  const v = ids.map((id) => lastSecondShown.get(id)).filter((x): x is number => x !== undefined);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

/** Long decays: the share of frames in the last second (3.2–4.2 s) that show a live reading. */
function runLongDecay(f: Fixture, config?: Partial<TrackerConfig>, id = f.id): FixtureResult {
  const r = { ...runFixture(f, config), id };
  const cfg: TrackerConfig = { a4: f.a4, targets: [], locked: null, tolerance: 3, ...config };
  const st = runOffline(f.samples, f.sr, cfg);
  const tail = st.filter((s) => s.t > f.samples.length / f.sr - 1);
  lastSecondShown.set(id, tail.filter((s) => s.cents !== null && !s.held).length / Math.max(1, tail.length));
  return r;
}

/** Everything: tuning set (every n-th fixture), long decays (chromatic + instrument context), safety fixtures, sequences. */
export function runAll(every = 1): FixtureResult[] {
  const out: FixtureResult[] = [];
  for (const f of tuningSet(every)) out.push(runFixture(f));
  for (const f of longDecays()) {
    out.push(runLongDecay(f));
    const bass = f.midi === 23 ? [23, 28, 33, 38, 43] : f.midi === 28 ? [28, 33, 38, 43] : [40, 45, 50, 55, 59, 64];
    out.push(runLongDecay(f, { targets: bass }, `${f.id}-instrument`));
  }
  for (const f of safetySet()) out.push(runFixture(f));
  const seq = sequenceSet();
  for (let i = 0; i < seq.length; i += every > 1 ? 2 : 1) out.push(runFixture(seq[i]));
  return out;
}
