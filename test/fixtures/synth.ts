// The TUNING SET (SPEC §13.1): seeded synthetic fixtures for the pitch detector and tracker. Thresholds may be tuned
// on this set only; its figures are NOT evidence of accuracy on unseen material (L27 rule 4) — that is the blind set
// written by a separate agent (P4). Relative imports only (scripts/ts-hooks.mjs runs this file in Node).
import { nearestNote } from '../../src/engine/notes';
import { normalizePattern } from '../../src/engine/metronome/pattern';
import { events } from '../../src/engine/metronome/schedule';
import { mixEvents, mulberry32, renderKit } from '../../src/engine/synth/clicks';

export type FixtureKind =
  | 'sine'
  | 'harmonic'
  | 'saw'
  | 'missingFundamental'
  | 'phoneMic'
  | 'pluck'
  | 'vibrato'
  | 'noisy'
  | 'humUnder'
  | 'humAlone'
  | 'noiseAlone'
  | 'clicksUnder'
  | 'clicksAlone'
  | 'sympathetic'
  | 'clipped'
  | 'longDecay'
  | 'safety'
  // Sequences (fix round 1, review S9) — built after the reviewer's probes (tn-review t1c/t14/t2/t3/t13); these are
  // tuning-set material now, not evidence:
  | 'nextString' // a string plucked while the previous one still rings (auto mode); truth = the newest string
  | 'pluckTrain' // one string re-plucked every 1.5 s while the peg is turned (+2 cents per pluck)
  | 'longRing' // a single low pluck ringing 6 s
  | 'glideUp' // auto mode: a ringing string tightened far past the next string (A4 in auto mode)
  | 'bowedHumBand' // bowed/sustained notes within ±1 Hz of 50/60/100/120 Hz, 4 s
  | 'bassPair'; // bass: E1 then A1 while E1 rings (resolution limit, reported only)

export type Fixture = {
  id: string;
  kind: FixtureKind;
  sr: number;
  a4: number;
  samples: Float32Array;
  /** Sample where the note starts (its attack). */
  onset: number;
  /** Sample where the note's steady part ends (scoring stops; decays continue after it). */
  end: number;
  /** First-partial frequency (null = no note in the file). */
  hz: number | null;
  /** Instantaneous first-partial frequency at time t (s) — vibrato fixtures vary. */
  hzAt?: (t: number) => number;
  /** Truth note at this A4 (null = none). */
  midi: number | null;
  /** Instrument context for tracker tests: target strings (MIDI, low → high) and a locked string index. */
  strings?: number[];
  locked?: number;
  snrDb?: number;
  inharmonicity?: number;
  /** Sequences: seconds after the onset from which "the newest note is shown" is scored (default 0.3). */
  coverFrom?: number;
  /** Other notes (Hz) still sounding in the scored part (the previous string of a sequence). */
  others?: number[];
};

type Rand = () => number;

// ---------- building blocks ----------

type Partial_ = { ratio: number; amp: number; tau: number; phase: number };

/** Additive tone with exact first partial f1 (inharmonic stretch keeps partial 1 at f1). */
function additive(
  out: Float64Array,
  from: number,
  f1: number,
  sr: number,
  partials: Partial_[],
  attackS: number,
  vibrato?: { cents: number; rate: number }
): void {
  const attack = Math.max(1, Math.round(attackS * sr));
  for (const p of partials) {
    const f = f1 * p.ratio;
    if (f >= 0.45 * sr) continue;
    const decay = Number.isFinite(p.tau) ? Math.exp(-1 / (p.tau * sr)) : 1;
    if (!vibrato) {
      // Recursive oscillator: exact frequency, 4 multiplies per sample.
      const cw = Math.cos((2 * Math.PI * f) / sr);
      const sw = Math.sin((2 * Math.PI * f) / sr);
      let re = Math.cos(p.phase);
      let im = Math.sin(p.phase);
      let g = p.amp;
      for (let i = from, n = 0; i < out.length; i++, n++) {
        const env = n < attack ? n / attack : 1;
        out[i] += g * env * im;
        const nr = re * cw - im * sw;
        im = re * sw + im * cw;
        re = nr;
        g *= decay;
        if (g < 1e-7) break;
      }
    } else {
      let phase = p.phase;
      let g = p.amp;
      for (let i = from, n = 0; i < out.length; i++, n++) {
        const t = n / sr;
        const inst = f * Math.pow(2, (vibrato.cents / 1200) * Math.sin(2 * Math.PI * vibrato.rate * t));
        const env = n < attack ? n / attack : 1;
        out[i] += g * env * Math.sin(phase);
        phase += (2 * Math.PI * inst) / sr;
        g *= decay;
      }
    }
  }
}

function pluckPartials(f1: number, sr: number, r: Rand, b: number, brightness = 1): Partial_[] {
  const pos = 0.12 + r() * 0.18; // pluck position along the string
  const tau1 = f1 < 60 ? 3 : f1 < 150 ? 2.2 : f1 < 400 ? 1.4 : 0.8;
  const out: Partial_[] = [];
  for (let k = 1; k <= 40; k++) {
    const ratio = k * Math.sqrt((1 + b * k * k) / (1 + b));
    if (f1 * ratio >= 0.45 * sr) break;
    const amp = (Math.abs(Math.sin(Math.PI * k * pos)) / Math.pow(k, 1.6 - 0.4 * brightness)) * (0.7 + 0.6 * r());
    out.push({ ratio, amp, tau: tau1 / (1 + 0.35 * (k - 1)), phase: r() * 2 * Math.PI });
  }
  return out;
}

function harmonicPartials(r: Rand, slope: number, count: number, from = 1): Partial_[] {
  const out: Partial_[] = [];
  for (let k = from; k <= count; k++) out.push({ ratio: k, amp: (1 / Math.pow(k, slope)) * (0.8 + 0.4 * r()), tau: Infinity, phase: r() * 2 * Math.PI });
  return out;
}

/** 2nd-order Butterworth high-pass (phone microphones are specified flat from ~100 Hz). */
function highpass(x: Float64Array, sr: number, fc: number): void {
  const w0 = (2 * Math.PI * fc) / sr;
  const q = Math.SQRT1_2;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 + cosw) / 2 / a0;
  const b1 = -(1 + cosw) / a0;
  const b2 = b0;
  const a1 = (-2 * cosw) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

function rmsOf(x: Float64Array, from: number, to: number): number {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i] * x[i];
  return Math.sqrt(e / Math.max(1, to - from));
}

/** White or pink noise (Paul Kellet's economy filter), unit RMS. */
function noise(n: number, r: Rand, pink: boolean): Float64Array {
  const out = new Float64Array(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    if (!pink) out[i] = w;
    else {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      out[i] = b0 + b1 + b2 + w * 0.1848;
    }
  }
  const s = rmsOf(out, 0, n);
  for (let i = 0; i < n; i++) out[i] /= s;
  return out;
}

function hum(n: number, sr: number, mains: 50 | 60, r: Rand): Float64Array {
  const out = new Float64Array(n);
  const ph = [r(), r(), r()].map((x) => x * 2 * Math.PI);
  const amps = [1, 0.5, 0.3];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    for (let h = 0; h < 3; h++) out[i] += amps[h] * Math.sin(2 * Math.PI * mains * (h + 1) * t + ph[h]);
  }
  const s = rmsOf(out, 0, n);
  for (let i = 0; i < n; i++) out[i] /= s;
  return out;
}

function toF32(x: Float64Array, peak = 0.5): Float32Array {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  const g = m > 0 ? peak / m : 1;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
  return out;
}

// ---------- the set ----------

const RATES = [44100, 48000] as const;
const A4S = [415, 440, 442, 466] as const;

/** A random target: MIDI note in [lo, hi] at a random A4 with a random offset of ±49 cents. */
function pickNote(r: Rand, lo: number, hi: number) {
  const a4 = A4S[Math.floor(r() * A4S.length)];
  const midi = lo + Math.floor(r() * (hi - lo + 1));
  const cents = (r() * 2 - 1) * 49;
  const hz = a4 * Math.pow(2, (midi + cents / 100 - 69) / 12);
  return { a4, hz };
}

type Spec = {
  kind: FixtureKind;
  seconds: number;
  lead: number; // seconds of background before the onset
  lo: number;
  hi: number;
  build: (ctx: { r: Rand; sr: number; f1: number; out: Float64Array; onset: number }) => { snrDb?: number; b?: number; vibrato?: boolean } | void;
};

function makeFixture(id: string, spec: Spec, seed: number): Fixture {
  const r = mulberry32(seed);
  const sr = RATES[Math.floor(r() * RATES.length)];
  const { a4, hz } = pickNote(r, spec.lo, spec.hi);
  const n = Math.round(spec.seconds * sr);
  const onset = Math.round(spec.lead * sr);
  const out = new Float64Array(n);
  const info = spec.build({ r, sr, f1: hz, out, onset }) ?? {};
  const noteless = spec.kind === 'humAlone' || spec.kind === 'noiseAlone' || spec.kind === 'clicksAlone';
  const fixture: Fixture = {
    id,
    kind: spec.kind,
    sr,
    a4,
    samples: toF32(out, spec.kind === 'clipped' ? 0.95 : 0.3 + 0.4 * r()),
    onset,
    end: Math.min(n, onset + Math.round(Math.min(spec.seconds - spec.lead, 1.5) * sr)),
    hz: noteless ? null : hz,
    midi: noteless ? null : nearestNote(hz, a4).midi,
    snrDb: info.snrDb,
    inharmonicity: info.b,
  };
  if (info.vibrato) fixture.hzAt = (t: number) => hz * Math.pow(2, (10 / 1200) * Math.sin(2 * Math.PI * 5.5 * (t - spec.lead)));
  return fixture;
}

function addNoise(ctx: { r: Rand; out: Float64Array; onset: number; sr: number }, snrDb: number, pink: boolean): void {
  const { r, out, onset, sr } = ctx;
  const sig = rmsOf(out, onset, Math.min(out.length, onset + Math.round(1.0 * sr)));
  const nz = noise(out.length, r, pink);
  const g = sig / Math.pow(10, snrDb / 20);
  for (let i = 0; i < out.length; i++) out[i] += g * nz[i];
}

/** Low-level background so "silence" is never digital zero (−70 dB re the note). */
function floorNoise(ctx: { r: Rand; out: Float64Array; onset: number; sr: number }): void {
  addNoise(ctx, 60, true);
}

const SPECS: { count: number; spec: Spec }[] = [
  { count: 40, spec: { kind: 'sine', seconds: 1.8, lead: 0.2, lo: 24, hi: 96, build: (c) => { additive(c.out, c.onset, c.f1, c.sr, [{ ratio: 1, amp: 1, tau: Infinity, phase: c.r() * 6.28 }], 0.01); floorNoise(c); } } },
  { count: 60, spec: { kind: 'harmonic', seconds: 1.8, lead: 0.2, lo: 24, hi: 96, build: (c) => { additive(c.out, c.onset, c.f1, c.sr, harmonicPartials(c.r, 1 + c.r(), 12), 0.02); floorNoise(c); } } },
  { count: 40, spec: { kind: 'saw', seconds: 1.8, lead: 0.2, lo: 28, hi: 96, build: (c) => { additive(c.out, c.onset, c.f1, c.sr, harmonicPartials(c.r, 1, 60), 0.02); floorNoise(c); } } },
  { count: 30, spec: { kind: 'missingFundamental', seconds: 1.8, lead: 0.2, lo: 40, hi: 84, build: (c) => { additive(c.out, c.onset, c.f1, c.sr, harmonicPartials(c.r, 0.8, 10, 2), 0.02); floorNoise(c); } } },
  { count: 60, spec: { kind: 'phoneMic', seconds: 2.2, lead: 0.2, lo: 23, hi: 76, build: (c) => { additive(c.out, c.onset, c.f1, c.sr, pluckPartials(c.f1, c.sr, c.r, 1e-4), 0.003); highpass(c.out, c.sr, 100); floorNoise(c); return { b: 1e-4 }; } } },
  ...[0, 1e-4, 5e-4, 1e-3].map((b) => ({ count: 30, spec: { kind: 'pluck' as const, seconds: 2.2, lead: 0.2, lo: 23, hi: 88, build: (c: { r: Rand; sr: number; f1: number; out: Float64Array; onset: number }) => { additive(c.out, c.onset, c.f1, c.sr, pluckPartials(c.f1, c.sr, c.r, b), 0.003); floorNoise(c); return { b }; } } })),
  { count: 30, spec: { kind: 'vibrato', seconds: 1.8, lead: 0.2, lo: 43, hi: 93, build: (c) => { additive(c.out, c.onset, c.f1, c.sr, harmonicPartials(c.r, 1.2, 10), 0.05, { cents: 10, rate: 5.5 }); floorNoise(c); return { vibrato: true }; } } },
  ...[30, 20, 10].flatMap((snr) =>
    [false, true].map((pink) => ({
      count: 20,
      spec: { kind: 'noisy' as const, seconds: 1.8, lead: 0.2, lo: 28, hi: 96, build: (c: { r: Rand; sr: number; f1: number; out: Float64Array; onset: number }) => { additive(c.out, c.onset, c.f1, c.sr, c.r() < 0.5 ? harmonicPartials(c.r, 1.3, 12) : pluckPartials(c.f1, c.sr, c.r, 1e-4), 0.005); addNoise(c, snr, pink); return { snrDb: snr }; } },
    }))
  ),
  { count: 30, spec: { kind: 'humUnder', seconds: 1.8, lead: 0.2, lo: 40, hi: 84, build: (c) => { additive(c.out, c.onset, c.f1, c.sr, pluckPartials(c.f1, c.sr, c.r, 1e-4), 0.003); const h = hum(c.out.length, c.sr, c.r() < 0.5 ? 50 : 60, c.r); const g = rmsOf(c.out, c.onset, c.onset + c.sr) * Math.pow(10, -(10 + c.r() * 10) / 20); for (let i = 0; i < h.length; i++) c.out[i] += g * h[i]; floorNoise(c); return { snrDb: 10 }; } } },
  { count: 10, spec: { kind: 'humAlone', seconds: 3, lead: 0.2, lo: 40, hi: 84, build: (c) => { const h = hum(c.out.length, c.sr, c.r() < 0.5 ? 50 : 60, c.r); for (let i = 0; i < h.length; i++) c.out[i] += 0.1 * h[i]; const nz = noise(c.out.length, c.r, true); for (let i = 0; i < nz.length; i++) c.out[i] += 0.003 * nz[i]; } } },
  { count: 10, spec: { kind: 'noiseAlone', seconds: 3, lead: 0.2, lo: 40, hi: 84, build: (c) => { const nz = noise(c.out.length, c.r, c.r() < 0.5); for (let i = 0; i < nz.length; i++) c.out[i] += 0.1 * nz[i]; } } },
  { count: 20, spec: { kind: 'clicksUnder', seconds: 2.2, lead: 0.2, lo: 40, hi: 84, build: (c) => { additive(c.out, c.onset, c.f1, c.sr, pluckPartials(c.f1, c.sr, c.r, 1e-4), 0.003); addClicks(c, 0.3); floorNoise(c); } } },
  { count: 5, spec: { kind: 'clicksAlone', seconds: 3, lead: 0.2, lo: 40, hi: 84, build: (c) => { c.out[0] = 1e-9; addClicks(c, 1, 0.3); const nz = noise(c.out.length, c.r, true); for (let i = 0; i < nz.length; i++) c.out[i] += 0.001 * nz[i]; } } },
  { count: 30, spec: { kind: 'sympathetic', seconds: 2.2, lead: 0.2, lo: 40, hi: 76, build: (c) => { additive(c.out, c.onset, c.f1, c.sr, pluckPartials(c.f1, c.sr, c.r, 1e-4), 0.003); const other = c.f1 * Math.pow(2, [5, 7, -5, 12, 4][Math.floor(c.r() * 5)] / 12); const tmp = new Float64Array(c.out.length); additive(tmp, c.onset, other, c.sr, pluckPartials(other, c.sr, c.r, 1e-4), 0.003); const g = (rmsOf(c.out, c.onset, c.onset + c.sr) / Math.max(1e-12, rmsOf(tmp, c.onset, c.onset + c.sr))) * 0.1; for (let i = 0; i < tmp.length; i++) c.out[i] += g * tmp[i]; floorNoise(c); } } },
  { count: 20, spec: { kind: 'clipped', seconds: 1.8, lead: 0.2, lo: 28, hi: 84, build: (c) => { additive(c.out, c.onset, c.f1, c.sr, pluckPartials(c.f1, c.sr, c.r, 1e-4), 0.003); let m = 0; for (const v of c.out) m = Math.max(m, Math.abs(v)); const lim = 0.3 * m; for (let i = 0; i < c.out.length; i++) c.out[i] = Math.max(-lim, Math.min(lim, c.out[i])); floorNoise(c); } } },
];

function addClicks(c: { r: Rand; sr: number; out: Float64Array; onset: number }, relLevel: number, absPeak?: number): void {
  const sr = c.sr;
  const list = events(normalizePattern({ bpm: 120 }), sr, 0, c.out.length, Math.round(c.r() * 0.4 * sr));
  const x = mixEvents(list, renderKit('click', sr), sr, 0, c.out.length, 1);
  let peakSig = 0;
  for (const v of c.out) peakSig = Math.max(peakSig, Math.abs(v));
  const g = absPeak ?? relLevel * (peakSig || 1);
  for (let i = 0; i < x.length; i++) c.out[i] += g * x[i];
}

/** The whole tuning set, deterministic. `every` > 1 keeps every n-th fixture (fast Jest subset). */
export function tuningSet(every = 1): Fixture[] {
  const out: Fixture[] = [];
  let seed = 1;
  for (const { count, spec } of SPECS) {
    for (let i = 0; i < count; i++, seed++) {
      if ((seed - 1) % every !== 0) continue;
      out.push(makeFixture(`${spec.kind}-${String(seed).padStart(3, '0')}`, spec, seed * 7919));
    }
  }
  return out;
}

/** Long decaying plucks of the lowest strings (A5: 0 octave flips over 4 s). */
export function longDecays(): Fixture[] {
  const notes = [
    { name: 'E1', midi: 28 },
    { name: 'B0', midi: 23 },
    { name: 'E2', midi: 40 },
  ];
  const out: Fixture[] = [];
  let seed = 424242;
  for (const { name, midi } of notes) {
    for (const sr of RATES) {
      for (const mic of [false, true]) {
        const r = mulberry32(seed++);
        const hz = 440 * Math.pow(2, (midi - 69) / 12);
        const n = Math.round(4.2 * sr);
        const onset = Math.round(0.2 * sr);
        const x = new Float64Array(n);
        additive(x, onset, hz, sr, pluckPartials(hz, sr, r, 1e-4), 0.003);
        if (mic) highpass(x, sr, 100);
        floorNoise({ r, out: x, onset, sr });
        out.push({ id: `longDecay-${name}-${sr}${mic ? '-mic' : ''}`, kind: 'longDecay', sr, a4: 440, samples: toF32(x), onset, end: n, hz, midi });
      }
    }
  }
  return out;
}

/** Harmonic tone with a time-varying fundamental `fAt(t)` (t from `from`), constant level after a 50 ms attack. */
function glideTone(out: Float64Array, from: number, to: number, sr: number, fAt: (t: number) => number, partials: number, r: Rand): void {
  const ph = Array.from({ length: partials }, () => r() * 2 * Math.PI);
  const amp = Array.from({ length: partials }, (_, k) => (1 / Math.pow(k + 1, 1.1)) * (0.8 + 0.4 * r()));
  const attack = Math.round(0.05 * sr);
  for (let i = from, n = 0; i < Math.min(to, out.length); i++, n++) {
    const f = fAt(n / sr);
    const env = n < attack ? n / attack : 1;
    for (let k = 0; k < partials; k++) {
      if ((k + 1) * f >= 0.45 * sr) break;
      ph[k] += (2 * Math.PI * (k + 1) * f) / sr;
      out[i] += env * amp[k] * Math.sin(ph[k]);
    }
  }
}

const GUITAR = [40, 45, 50, 55, 59, 64];
const BASS = [28, 33, 38, 43];

/**
 * Note sequences (review S9): what an ordinary tuning session does and the single-note set never did. Deterministic.
 * Scoring window per fixture: [onset + coverFrom, end]; truth = `hzAt` (or `hz`).
 */
export function sequenceSet(): Fixture[] {
  const out: Fixture[] = [];
  let seed = 9001;
  const hzOf = (m: number, c = 0) => 440 * Math.pow(2, (m + c / 100 - 69) / 12);
  // Next string while the previous rings: every adjacent pair up and down, 0.5/1/2 s later, same or double force.
  for (let i = 0; i + 1 < GUITAR.length; i++) {
    for (const [a, b] of [[GUITAR[i], GUITAR[i + 1]], [GUITAR[i + 1], GUITAR[i]]]) {
      for (const dt of [0.5, 1, 2]) {
        for (const force of [1, 2]) {
          const r = mulberry32(seed++);
          const sr = RATES[seed % 2];
          const n = Math.round((0.2 + dt + 2.3) * sr);
          const x = new Float64Array(n);
          const t1 = Math.round(0.2 * sr);
          const t2 = Math.round((0.2 + dt) * sr);
          const f1 = hzOf(a, (r() - 0.5) * 20);
          const f2 = hzOf(b, (r() - 0.5) * 20);
          additive(x, t1, f1, sr, pluckPartials(f1, sr, r, 1e-4), 0.003);
          const y = new Float64Array(n);
          additive(y, t2, f2, sr, pluckPartials(f2, sr, r, 1e-4), 0.003);
          const g = force * (rmsOf(x, t1, t1 + Math.round(0.3 * sr)) / Math.max(1e-12, rmsOf(y, t2, t2 + Math.round(0.3 * sr))));
          for (let k = 0; k < n; k++) x[k] += g * y[k];
          floorNoise({ r, out: x, onset: t1, sr });
          out.push({ id: `next-${a}-${b}-${dt}-x${force}`, kind: 'nextString', sr, a4: 440, samples: toF32(x), onset: t2, end: t2 + Math.round(2 * sr), hz: f2, midi: b, strings: GUITAR, inharmonicity: 1e-4, others: [f1] });
        }
      }
    }
  }
  // Pluck trains: E2, A2 (guitar), E1 (bass) every 1.5 s for 9 s, peg turned +2 cents per pluck, never damped.
  for (const [m, strings] of [[40, GUITAR], [45, GUITAR], [28, BASS]] as const) {
    const r = mulberry32(seed++);
    const sr = RATES[seed % 2];
    const n = Math.round(9.5 * sr);
    const x = new Float64Array(n);
    const starts: number[] = [];
    for (let k = 0; k < 6; k++) {
      const at = Math.round((0.2 + 1.5 * k) * sr);
      starts.push(at / sr);
      const f = hzOf(m, -12 + 2 * k);
      // A re-pluck replaces the string's vibration (the pick stops it): the previous one is damped over 10 ms.
      const y = new Float64Array(n);
      additive(y, at, f, sr, pluckPartials(f, sr, r, 1e-4), 0.003);
      const next = Math.round((0.2 + 1.5 * (k + 1)) * sr);
      const fade = Math.round(0.01 * sr);
      for (let i = at; i < n; i++) x[i] += y[i] * (i < next ? 1 : Math.max(0, 1 - (i - next) / fade));
    }
    floorNoise({ r, out: x, onset: Math.round(0.2 * sr), sr });
    const hzAt = (t: number) => hzOf(m, -12 + 2 * Math.max(0, starts.filter((s0) => s0 <= t).length - 1));
    out.push({ id: `train-${m}`, kind: 'pluckTrain', sr, a4: 440, samples: toF32(x), onset: Math.round(0.2 * sr), end: n, hz: hzOf(m, -12), hzAt, midi: m, strings: [...strings], coverFrom: 0.3 });
  }
  // Long rings: one pluck, 6 s (E1, A1, E2, A2, D3), chromatic and instrument context.
  for (const m of [28, 33, 40, 45, 50]) {
    for (const ctx of ['chromatic', 'instrument'] as const) {
      const r = mulberry32(seed++);
      const sr = RATES[seed % 2];
      const n = Math.round(6.4 * sr);
      const x = new Float64Array(n);
      const at = Math.round(0.2 * sr);
      const f = hzOf(m, (r() - 0.5) * 30);
      const partials = pluckPartials(f, sr, r, 1e-4).map((p) => ({ ...p, tau: p.tau * 1.5 })); // a long-sustaining string
      additive(x, at, f, sr, partials, 0.003);
      floorNoise({ r, out: x, onset: at, sr });
      out.push({ id: `ring-${m}-${ctx}`, kind: 'longRing', sr, a4: 440, samples: toF32(x), onset: at, end: Math.round(6.2 * sr), hz: f, midi: m, strings: ctx === 'instrument' ? (m < 40 ? BASS : GUITAR) : undefined });
    }
  }
  // Upward glides in auto mode (A4): each guitar string, sustained, tightened by +450 cents over 2.5 s.
  for (const m of GUITAR) {
    const r = mulberry32(seed++);
    const sr = RATES[seed % 2];
    const n = Math.round(3.4 * sr);
    const x = new Float64Array(n);
    const at = Math.round(0.2 * sr);
    const fAt = (t: number) => hzOf(m) * Math.pow(2, Math.min(450, Math.max(0, (t - 0.2) * 180)) / 1200);
    glideTone(x, at, n, sr, fAt, 10, r);
    floorNoise({ r, out: x, onset: at, sr });
    out.push({ id: `glide-${m}`, kind: 'glideUp', sr, a4: 440, samples: toF32(x), onset: at, end: n, hz: hzOf(m), hzAt: (t: number) => fAt(t - 0.2), midi: m, strings: GUITAR });
  }
  // Bowed/sustained notes inside the old ±1 Hz hum band: shown for all 4 s (S4).
  const bowed: { id: string; hz: number; strings?: number[]; a4: number }[] = [
    { id: 'B1-30c', hz: hzOf(35, -30), strings: [30, 35, 40, 45], a4: 440 }, // solo-tuned double bass, 60.67 Hz
    { id: 'G2+40c', hz: hzOf(43, 40), strings: BASS, a4: 440 }, // 100.3 Hz
    { id: 'G2+40c-chromatic', hz: hzOf(43, 40), a4: 440 },
    { id: 'G1-at-442', hz: 442 * Math.pow(2, (31 - 69) / 12), strings: [31, 36, 41, 46], a4: 442 }, // 49.27 Hz, Drop C bass-like
    { id: 'B1-at-432', hz: 432 * Math.pow(2, (35 - 69) / 12), strings: [35, 42, 47, 52, 56, 61], a4: 432 }, // 60.6 Hz, Drop B
  ];
  for (const b of bowed) {
    const r = mulberry32(seed++);
    const sr = RATES[seed % 2];
    const n = Math.round(4.4 * sr);
    const x = new Float64Array(n);
    const at = Math.round(0.2 * sr);
    additive(x, at, b.hz, sr, harmonicPartials(r, 1, 10), 0.05);
    floorNoise({ r, out: x, onset: at, sr });
    out.push({ id: `bowed-${b.id}`, kind: 'bowedHumBand', sr, a4: b.a4, samples: toF32(x), onset: at, end: Math.round(4.3 * sr), hz: b.hz, midi: nearestNote(b.hz, b.a4).midi, strings: b.strings });
  }
  // Bass: E1 ringing, A1 plucked 1 s later (13.7 Hz between their partials — at the window's resolution limit).
  for (const [a, b] of [[28, 33], [33, 28], [33, 38]]) {
    const r = mulberry32(seed++);
    const sr = RATES[seed % 2];
    const n = Math.round(3.6 * sr);
    const x = new Float64Array(n);
    const t1 = Math.round(0.2 * sr);
    const t2 = Math.round(1.2 * sr);
    const f1 = hzOf(a);
    const f2 = hzOf(b, 5);
    additive(x, t1, f1, sr, pluckPartials(f1, sr, r, 2e-4), 0.003);
    additive(x, t2, f2, sr, pluckPartials(f2, sr, r, 2e-4), 0.003);
    floorNoise({ r, out: x, onset: t1, sr });
    out.push({ id: `bass-${a}-${b}`, kind: 'bassPair', sr, a4: 440, samples: toF32(x), onset: t2, end: t2 + Math.round(2 * sr), hz: f2, midi: b, strings: BASS, inharmonicity: 2e-4, others: [f1] });
  }
  return out;
}

/** Safety fixtures (A4): a string locked to a target while a note ≥ 1 octave above it sounds. */
export function safetySet(): Fixture[] {
  const out: Fixture[] = [];
  const guitar = [40, 45, 50, 55, 59, 64];
  let seed = 777;
  for (let s = 0; s < guitar.length; s++) {
    for (const up of [12, 19, 24]) {
      const r = mulberry32(seed++);
      const sr = RATES[s % 2];
      const midi = guitar[s] + up;
      const hz = 440 * Math.pow(2, (midi - 69 + (r() - 0.5) * 0.6) / 12);
      const n = Math.round(1.8 * sr);
      const onset = Math.round(0.2 * sr);
      const x = new Float64Array(n);
      additive(x, onset, hz, sr, pluckPartials(hz, sr, r, 1e-4), 0.003);
      floorNoise({ r, out: x, onset, sr });
      out.push({ id: `safety-${s}-${up}`, kind: 'safety', sr, a4: 440, samples: toF32(x), onset, end: n, hz, midi, strings: guitar, locked: s });
    }
  }
  return out;
}
