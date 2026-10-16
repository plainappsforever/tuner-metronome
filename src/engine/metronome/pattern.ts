// Metronome pattern (SPEC §5.5, JSON `v: 1`) and its normalisation. Shared by the schedule, presets and backups.

export type Level = 'accent' | 'normal' | 'soft' | 'mute';
export const LEVELS: readonly Level[] = ['accent', 'normal', 'soft', 'mute'];

export type SubPulse = { num: number; den: number; level: Level };

export type TrainerEvery = { bars: number } | { seconds: number };
export type Trainer = {
  startBpm: number;
  targetBpm: number;
  stepBpm: number; // 1–20
  every: TrainerEvery; // bars 1–64 | seconds 5–600
  mode: 'once' | 'cycle';
};

export type MuteCycle = { playBars: number; muteBars: number } | { randomPercent: number; seed: number };

export type Sounds = { accent: string; beat: string; sub: string; poly: string; countIn: string };

export type Pattern = {
  v: 1;
  bpm: number; // integer 10–400
  beats: number; // 1–16 units per bar
  unit: 2 | 4 | 8 | 16;
  /** 'dotted': compound meter counted in dotted units (3 units per counted beat; bpm counts dotted beats). */
  pulse: 'unit' | 'dotted';
  /** Uneven grouping of the units into counted beats, e.g. [2, 2, 3] for 7/8 (bpm counts units). */
  groups?: number[];
  /** One level per unit. */
  accents: Level[];
  /** Offsets within each unit as reduced fractions; the first pulse is the unit itself (0/1). */
  sub: { pulses: SubPulse[] };
  /** 0.50–0.75: position of the 2nd of two equal pulses within the unit. */
  swing: number;
  poly?: { n: number; level: Level; sound: string };
  sounds: Sounds;
  volume: number; // 0–1
  countInBars: number; // 0–2
  trainer?: Trainer;
  mute?: MuteCycle;
};

export const BPM_MIN = 10;
export const BPM_MAX = 400;
export const BEATS_MAX = 16;
export const SUB_DEN_MAX = 16;

export const DEFAULT_SOUNDS: Sounds = { accent: 'click', beat: 'click', sub: 'click', poly: 'wood', countIn: 'beep' };

export const DEFAULT_PATTERN: Pattern = {
  v: 1,
  bpm: 100,
  beats: 4,
  unit: 4,
  pulse: 'unit',
  accents: ['accent', 'normal', 'normal', 'normal'],
  sub: { pulses: [{ num: 0, den: 1, level: 'normal' }] },
  swing: 0.5,
  sounds: DEFAULT_SOUNDS,
  volume: 0.8,
  countInBars: 0,
};

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(hi, Math.max(lo, n));
};
const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
};
const level = (v: unknown, fallback: Level): Level => (LEVELS.includes(v as Level) ? (v as Level) : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.length > 0 && v.length <= 40 ? v : fallback);

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Default accents: first unit accented; in dotted/grouped meters the other counted-beat starts normal, the rest soft. */
export function defaultAccents(beats: number, starts: boolean[]): Level[] {
  return Array.from({ length: beats }, (_, i) => (i === 0 ? 'accent' : starts[i] ? 'normal' : 'soft'));
}

/** Which units start a counted beat (true) for this meter. */
export function beatStarts(p: Pick<Pattern, 'beats' | 'pulse' | 'groups'>): boolean[] {
  const starts = new Array<boolean>(p.beats).fill(false);
  if (p.groups && p.groups.length > 0) {
    let at = 0;
    for (const g of p.groups) {
      starts[at] = true;
      at += g;
    }
  } else if (p.pulse === 'dotted') {
    for (let i = 0; i < p.beats; i += 3) starts[i] = true;
  } else starts.fill(true);
  return starts;
}

/** Units per counted beat for the tempo (bpm counts dotted beats in 'dotted' meters, else units). */
export function unitsPerBpmBeat(p: Pick<Pattern, 'pulse' | 'groups'>): number {
  return p.pulse === 'dotted' && !(p.groups && p.groups.length > 0) ? 3 : 1;
}

function normalizeTrainer(v: unknown): Trainer | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const every = o.every as Record<string, unknown> | undefined;
  let e: TrainerEvery;
  if (every && typeof every.seconds === 'number') e = { seconds: clampInt(every.seconds, 5, 600, 30) };
  else e = { bars: clampInt(every?.bars, 1, 64, 4) };
  return {
    startBpm: clampInt(o.startBpm, BPM_MIN, BPM_MAX, 80),
    targetBpm: clampInt(o.targetBpm, BPM_MIN, BPM_MAX, 120),
    stepBpm: clampInt(o.stepBpm, 1, 20, 4),
    every: e,
    mode: o.mode === 'cycle' ? 'cycle' : 'once',
  };
}

function normalizeMute(v: unknown): MuteCycle | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.randomPercent === 'number') {
    return { randomPercent: clampInt(o.randomPercent, 0, 75, 25), seed: clampInt(o.seed, 0, 0xffffffff, 1) >>> 0 };
  }
  return { playBars: clampInt(o.playBars, 1, 16, 2), muteBars: clampInt(o.muteBars, 1, 16, 2) };
}

/**
 * Validates and clamps any parsed JSON into a usable pattern (presets, backups, live edits). Never throws; unknown
 * fields are dropped. Sub-pulses are reduced, deduplicated, sorted, and always start with 0/1.
 */
export function normalizePattern(input: unknown): Pattern {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const beats = clampInt(o.beats, 1, BEATS_MAX, DEFAULT_PATTERN.beats);
  const unit = ([2, 4, 8, 16] as const).includes(o.unit as 2) ? (o.unit as Pattern['unit']) : 4;
  let groups: number[] | undefined;
  if (Array.isArray(o.groups) && o.groups.length > 0) {
    const g = o.groups.map((x) => clampInt(x, 1, BEATS_MAX, 1));
    if (g.reduce((a, b) => a + b, 0) === beats) groups = g;
  }
  const pulse: Pattern['pulse'] = o.pulse === 'dotted' && beats % 3 === 0 && !groups ? 'dotted' : 'unit';
  const starts = beatStarts({ beats, pulse, groups });
  const rawAcc = Array.isArray(o.accents) ? o.accents : [];
  const fallbackAcc = defaultAccents(beats, starts);
  const accents = fallbackAcc.map((d, i) => level(rawAcc[i], d));

  const seen = new Map<string, SubPulse>();
  const rawSub = (o.sub as Record<string, unknown> | undefined)?.pulses;
  for (const item of Array.isArray(rawSub) ? rawSub : []) {
    const pi = (item ?? {}) as Record<string, unknown>;
    const den = clampInt(pi.den, 1, SUB_DEN_MAX, 1);
    const num = clampInt(pi.num, 0, den - 1, 0);
    const g = gcd(num, den) || 1;
    const key = `${num / g}/${den / g}`;
    if (!seen.has(key)) seen.set(key, { num: num / g, den: den / g, level: level(pi.level, 'normal') });
  }
  const zero = seen.get('0/1');
  seen.delete('0/1');
  const pulses = [
    { num: 0, den: 1, level: zero?.level ?? ('normal' as Level) },
    ...[...seen.values()].sort((a, b) => a.num * b.den - b.num * a.den),
  ];

  const soundsIn = (o.sounds ?? {}) as Record<string, unknown>;
  const polyIn = o.poly as Record<string, unknown> | undefined;
  const pattern: Pattern = {
    v: 1,
    bpm: clampInt(o.bpm, BPM_MIN, BPM_MAX, DEFAULT_PATTERN.bpm),
    beats,
    unit,
    pulse,
    ...(groups ? { groups } : {}),
    accents,
    sub: { pulses },
    swing: Math.round(clampNum(o.swing, 0.5, 0.75, 0.5) * 100) / 100,
    ...(polyIn && typeof polyIn === 'object'
      ? { poly: { n: clampInt(polyIn.n, 2, 16, 3), level: level(polyIn.level, 'normal'), sound: str(polyIn.sound, 'wood') } }
      : {}),
    sounds: {
      accent: str(soundsIn.accent, DEFAULT_SOUNDS.accent),
      beat: str(soundsIn.beat, DEFAULT_SOUNDS.beat),
      sub: str(soundsIn.sub, DEFAULT_SOUNDS.sub),
      poly: str(soundsIn.poly, DEFAULT_SOUNDS.poly),
      countIn: str(soundsIn.countIn, DEFAULT_SOUNDS.countIn),
    },
    volume: Math.round(clampNum(o.volume, 0, 1, DEFAULT_PATTERN.volume) * 100) / 100,
    countInBars: clampInt(o.countInBars, 0, 2, 0),
  };
  const trainer = normalizeTrainer(o.trainer);
  if (trainer) pattern.trainer = trainer;
  const mute = normalizeMute(o.mute);
  if (mute) pattern.mute = mute;
  return pattern;
}

/** True when two patterns have the same bar structure (a live edit may then apply at the next beat). */
export function sameMeter(a: Pattern, b: Pattern): boolean {
  return (
    a.beats === b.beats &&
    a.unit === b.unit &&
    a.pulse === b.pulse &&
    JSON.stringify(a.groups ?? null) === JSON.stringify(b.groups ?? null)
  );
}
