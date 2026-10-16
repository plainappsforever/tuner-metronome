// Speed trainer, mute cycle and the shared integer helpers (SPEC §5.6). Bars are counted from the trainer's/mute
// cycle's origin bar (0 = the first bar after the count-in, or the bar where a live edit installed a new trainer).
import type { MuteCycle, Trainer } from './pattern';

/** The tempo steps of a trainer: start, start ± step, …, target (the last step is clamped to the target). */
export function trainerValues(tr: Trainer): number[] {
  const dir = tr.targetBpm >= tr.startBpm ? 1 : -1;
  const values = [tr.startBpm];
  let v = tr.startBpm;
  while (v !== tr.targetBpm) {
    v += dir * tr.stepBpm;
    if ((dir > 0 && v > tr.targetBpm) || (dir < 0 && v < tr.targetBpm)) v = tr.targetBpm;
    values.push(v);
  }
  return values;
}

/** Tempo after `step` steps: 'once' stays at the target, 'cycle' restarts at the start after the target. */
export function trainerBpmForStep(tr: Trainer, step: number): number {
  const values = trainerValues(tr);
  const i = tr.mode === 'cycle' ? step % values.length : Math.min(step, values.length - 1);
  return values[i];
}

/** Bars-mode trainer: tempo of bar `bar` (counted from the trainer origin). Seconds mode needs the timeline. */
export function bpmForBar(tr: Trainer, bar: number): number {
  if (!('bars' in tr.every)) throw new Error('bpmForBar: seconds-mode trainers depend on bar durations; use barTimeline');
  return trainerBpmForStep(tr, Math.floor(Math.max(0, bar) / tr.every.bars));
}

/**
 * 32-bit integer hash (lowbias32, public domain, by Chris Wellons). Portable to Swift/Kotlin with UInt32/Int
 * arithmetic: every step is a 32-bit xor, unsigned shift or wrapping multiply.
 */
export function hash32(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** Deterministic per-bar random number 0–99 for a seed. */
export function barRandom(seed: number, bar: number): number {
  return hash32((seed + Math.imul(bar, 0x9e3779b9)) >>> 0) % 100;
}

/**
 * Is bar `bar` (counted from the mute cycle's origin, ≥ 0) muted? play/mute: bars play, then mute, repeating.
 * Random: each bar after the first is muted with `randomPercent` % probability, reproducible from the seed (the first
 * bar always plays so the player hears the tempo; D29).
 */
export function isMutedBar(mute: MuteCycle | undefined, bar: number): boolean {
  if (!mute || bar < 0) return false;
  if ('randomPercent' in mute) return bar > 0 && barRandom(mute.seed, bar) < mute.randomPercent;
  return bar % (mute.playBars + mute.muteBars) >= mute.playBars;
}
