// Click kits (SPEC §5.8): 6 kits × 5 voices, synthesised (no licensing; Breathe D19), float32 mono, ≤ 40 ms, 1 ms
// linear attack, exponential decay. Accent = the beat timbre +5 semitones and +3 dB. Deterministic (seeded noise), so
// scripts/gen-sounds.mjs writes byte-identical tables on every run.
//
// The mixer here is the reference for the native renderers: voices add, at most 8 at once (the oldest is dropped),
// a voice of the same kind retriggering is cut with a 2 ms linear fade, the sum is soft-clipped to ±1.
import type { Level } from '../metronome/pattern';
import type { EventKind, MetronomeEvent } from '../metronome/schedule';

export const KITS = ['click', 'wood', 'beep', 'cowbell', 'stick', 'soft'] as const;
export type Kit = (typeof KITS)[number];
export const VOICES = ['accent', 'beat', 'sub', 'poly', 'countIn'] as const;
export type Voice = (typeof VOICES)[number];

export const CLICK_MAX_S = 0.04;
const ATTACK_S = 0.001;

type KitSpec = {
  /** Base frequency of the beat voice. */
  f0: number;
  /** Partials as [frequency ratio, amplitude]. */
  partials: [number, number][];
  /** Noise share 0–1 (white noise, deterministic). */
  noise: number;
  /** Exponential decay time constant in seconds. */
  tau: number;
  /** Length in seconds (≤ 40 ms). */
  length: number;
  /** Peak gain of the beat voice. */
  gain: number;
};

const SPECS: Record<Kit, KitSpec> = {
  click: { f0: 1800, partials: [[1, 1]], noise: 0.3, tau: 0.004, length: 0.025, gain: 0.5 },
  wood: { f0: 900, partials: [[1, 1], [2.32, 0.4], [4.25, 0.15]], noise: 0.05, tau: 0.008, length: 0.035, gain: 0.5 },
  beep: { f0: 1000, partials: [[1, 1]], noise: 0, tau: 0.015, length: 0.04, gain: 0.4 },
  cowbell: { f0: 587, partials: [[1, 1], [1.44, 0.8], [3, 0.2]], noise: 0, tau: 0.012, length: 0.04, gain: 0.35 },
  stick: { f0: 2500, partials: [[1, 0.6], [1.6, 0.3]], noise: 0.6, tau: 0.0025, length: 0.02, gain: 0.5 },
  soft: { f0: 600, partials: [[1, 1], [2, 0.1]], noise: 0, tau: 0.01, length: 0.04, gain: 0.3 },
};

/** Voice offsets: [semitones, dB] relative to the beat voice. */
const VOICE_SHIFT: Record<Voice, [number, number]> = {
  accent: [5, 3],
  beat: [0, 0],
  sub: [-3, -6],
  poly: [7, -2],
  countIn: [12, -3],
};

/** Deterministic PRNG (mulberry32), portable 32-bit arithmetic. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderClick(kit: Kit, voice: Voice, sr: number): Float32Array {
  const spec = SPECS[kit];
  const [semi, db] = VOICE_SHIFT[voice];
  const f = spec.f0 * Math.pow(2, semi / 12);
  const gain = spec.gain * Math.pow(10, db / 20);
  const n = Math.round(spec.length * sr);
  const attack = Math.max(1, Math.round(ATTACK_S * sr));
  const rand = mulberry32(KITS.indexOf(kit) * 16 + VOICES.indexOf(voice) + 1);
  const norm = spec.partials.reduce((a, [, amp]) => a + amp, 0) + spec.noise;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let x = 0;
    for (const [ratio, amp] of spec.partials) x += amp * Math.sin(2 * Math.PI * f * ratio * t);
    x += spec.noise * (2 * rand() - 1);
    const env = (i < attack ? i / attack : 1) * Math.exp(-t / spec.tau);
    // Last 1 ms fades to exactly 0 so a table never ends with a step.
    const tail = Math.min(1, (n - 1 - i) / attack);
    out[i] = (gain / norm) * x * env * tail;
  }
  return out;
}

export type ClickTables = Record<Voice, Float32Array>;

export function renderKit(kit: Kit, sr: number): ClickTables {
  return Object.fromEntries(VOICES.map((v) => [v, renderClick(kit, v, sr)])) as ClickTables;
}

export const LEVEL_GAIN: Record<Level, number> = { accent: 1, normal: 1, soft: 0.5, mute: 0 };
const MAX_VOICES = 8;
const KNEE = 0.8;

/** Soft clip: linear up to ±0.8, then a tanh knee that never exceeds ±1. */
export function softClip(x: number): number {
  const a = Math.abs(x);
  if (a <= KNEE) return x;
  return Math.sign(x) * (KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE)));
}

function voiceFor(kind: EventKind): Voice {
  return kind;
}

type Playing = { table: Float32Array; pos: number; gain: number; kind: EventKind; fadeLeft: number; fadeLen: number };

/**
 * Renders events (sorted by sample) into `frames` samples starting at sample `from`. Reference implementation of the
 * native mixing rules; used by tests (no clipping at 400 BPM 16ths + poly 16) and by the native parity self-test.
 */
export function mixEvents(
  list: readonly MetronomeEvent[],
  tables: ClickTables,
  sr: number,
  from: number,
  frames: number,
  volume = 1
): Float32Array {
  const out = new Float32Array(frames);
  const playing: Playing[] = [];
  const fade = Math.max(1, Math.round(0.002 * sr));
  let ei = 0;
  while (ei < list.length && list[ei].sample < from) ei++;
  for (let i = 0; i < frames; i++) {
    const s = from + i;
    while (ei < list.length && list[ei].sample === s) {
      const e = list[ei++];
      const gain = LEVEL_GAIN[e.level] * volume;
      if (gain === 0) continue;
      for (const p of playing) if (p.kind === e.kind && p.fadeLeft < 0) p.fadeLeft = p.fadeLen = fade;
      if (playing.length >= MAX_VOICES) playing.shift();
      playing.push({ table: tables[voiceFor(e.kind)], pos: 0, gain, kind: e.kind, fadeLeft: -1, fadeLen: fade });
    }
    let x = 0;
    for (let k = playing.length - 1; k >= 0; k--) {
      const p = playing[k];
      let g = p.gain;
      if (p.fadeLeft >= 0) {
        g *= p.fadeLeft / p.fadeLen;
        p.fadeLeft--;
      }
      x += g * p.table[p.pos++];
      if (p.pos >= p.table.length || p.fadeLeft === 0) playing.splice(k, 1);
    }
    out[i] = softClip(x);
  }
  return out;
}
