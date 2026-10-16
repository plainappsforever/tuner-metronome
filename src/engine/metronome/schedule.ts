// Metronome schedule (SPEC §5.5) — the reference the native renderers port line by line (§6, golden vectors A10).
//
// Exact integer maths: within a constant-tempo SEGMENT starting at integer sample S0, grid point x/den units after the
// segment start sits at S0 + round(x · 60·sr / (bpm·q·den)), computed as divRound(x·60·sr, bpm·q·den) — no
// accumulation, so 0 drift; per-click rounding ≤ ½ sample. q = units per counted beat for the tempo (3 in dotted
// meters, else 1). A tempo change (trainer step at a bar line, live edit at a beat or bar) starts a new segment at the
// boundary sample computed under the OLD tempo.
//
// Range: x·60·sr must stay < 2^52 for exact doubles: with den ≤ 100 (swing) at 48 kHz that is 15.6 million units per
// segment (≥ 27 days at 400 BPM). The native ports use 64-bit integers.
import { beatStarts, sameMeter, unitsPerBpmBeat, type Level, type Pattern } from './pattern';
import { isMutedBar, trainerBpmForStep } from './trainer';

export type EventKind = 'accent' | 'beat' | 'sub' | 'poly' | 'countIn';

export type MetronomeEvent = {
  sample: number;
  kind: EventKind;
  level: Level;
  /** Bar index; count-in bars are negative (−countInBars … −1). */
  bar: number;
  /** Unit index within the bar (poly: pulse index j of n). */
  beat: number;
  /** Sub-pulse index within the unit (0 = the unit itself; poly: 0). */
  pulse: number;
};

/** round(n / d) for integers n ≥ 0, d > 0, halves rounded up: floor((2n + d) / (2d)), exact for 2n + d < 2^53. */
export function divRound(n: number, d: number): number {
  const a = 2 * n + d;
  const b = 2 * d;
  let q = Math.floor(a / b);
  // Correct a possible off-by-one of the floating-point division (cannot happen below 2^52, kept for safety).
  if (q * b > a) q -= 1;
  else if ((q + 1) * b <= a) q += 1;
  return q;
}

const KIND_ORDER: Record<EventKind, number> = { countIn: 0, accent: 1, beat: 2, sub: 3, poly: 4 };

function compareEvents(x: MetronomeEvent, y: MetronomeEvent): number {
  return x.sample - y.sample || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.beat - y.beat || x.pulse - y.pulse;
}

/** Sub-pulse fractions after swing: with exactly two pulses 0 and 1/2, the second moves to swing (in 1/100 units). */
export function effectivePulses(p: Pattern): { num: number; den: number; level: Level }[] {
  const ps = p.sub.pulses;
  if (ps.length === 2 && ps[1].num * 2 === ps[1].den && p.swing !== 0.5) {
    return [ps[0], { num: Math.round(p.swing * 100), den: 100, level: ps[1].level }];
  }
  return ps;
}

type Segment = { s0: number; bpm: number; q: number };

/** Sample of grid point (x / den) units after the segment start. */
function at(seg: Segment, x: number, den: number, sr: number): number {
  return seg.s0 + divRound(x * 60 * sr, seg.bpm * seg.q * den);
}

type BarPlan = {
  bar: number;
  pattern: Pattern;
  seg: Segment;
  /** Units of the segment elapsed at this bar's unit 0 (negative when the segment began mid-bar). */
  uOffset: number;
  /** First unit of this bar generated under this plan (> 0 after a mid-bar edit). */
  fromUnit: number;
  barStart: number;
  muted: boolean;
};

/**
 * Incremental scheduler: `next()` returns events in time order, forever. `update()` installs a new pattern at the
 * next beat or bar boundary after the last event returned. Deterministic: the same calls give the same events.
 */
export class Scheduler {
  readonly sr: number;
  private pattern: Pattern;
  private queue: MetronomeEvent[] = [];
  private qi = 0;
  private plan!: BarPlan;
  private lastSample = -1;
  // Trainer/mute state (origin = bar where the trainer/mute cycle started counting).
  private trainerOrigin = 0;
  private muteOrigin = 0;
  private step = 0;
  private lastStepSample = 0;

  constructor(pattern: Pattern, sr: number, startSample = 0) {
    if (!Number.isInteger(sr) || sr < 8000 || sr > 192000) throw new Error(`bad sample rate ${sr}`);
    this.sr = sr;
    this.pattern = pattern;
    const bar = pattern.countInBars > 0 ? -pattern.countInBars : 0; // never -0
    const bpm = this.bpmAtBar(pattern, 0, startSample, true);
    const seg: Segment = { s0: startSample, bpm, q: unitsPerBpmBeat(pattern) };
    this.plan = { bar, pattern, seg, uOffset: 0, fromUnit: 0, barStart: startSample, muted: false };
    this.fillBar();
  }

  /** Tempo for bar `bar`; advances the seconds-mode trainer state when `commit`. */
  private bpmAtBar(p: Pattern, bar: number, barStart: number, commit: boolean): number {
    const tr = p.trainer;
    if (!tr) return p.bpm;
    const rel = bar - this.trainerOrigin;
    if (rel <= 0) {
      if (commit && rel === 0) {
        this.step = 0;
        this.lastStepSample = barStart;
      }
      return trainerBpmForStep(tr, 0);
    }
    if ('bars' in tr.every) return trainerBpmForStep(tr, Math.floor(rel / tr.every.bars));
    // Seconds mode: step at the first bar line at or after `seconds` since the last step.
    if (commit && barStart - this.lastStepSample >= tr.every.seconds * this.sr) {
      this.step += 1;
      this.lastStepSample = barStart;
    }
    return trainerBpmForStep(tr, this.step);
  }

  /** Generates the current plan's bar (from `fromUnit`) into the queue. */
  private fillBar(): void {
    const { bar, pattern: p, seg, uOffset, fromUnit, barStart, muted } = this.plan;
    const sr = this.sr;
    const starts = beatStarts(p);
    const pulses = effectivePulses(p);
    const out: MetronomeEvent[] = [];
    const countIn = bar < 0;
    for (let u = fromUnit; u < p.beats; u++) {
      const x = uOffset + u;
      if (countIn) {
        if (starts[u]) out.push({ sample: at(seg, x, 1, sr), kind: 'countIn', level: 'normal', bar, beat: u, pulse: 0 });
        continue;
      }
      const lv = p.accents[u];
      const kind: EventKind = lv === 'accent' ? 'accent' : starts[u] ? 'beat' : 'sub';
      out.push({ sample: at(seg, x, 1, sr), kind, level: muted ? 'mute' : lv, bar, beat: u, pulse: 0 });
      for (let k = 1; k < pulses.length; k++) {
        const { num, den, level } = pulses[k];
        out.push({
          sample: at(seg, x * den + num, den, sr),
          kind: 'sub',
          level: muted ? 'mute' : level,
          bar,
          beat: u,
          pulse: k,
        });
      }
    }
    if (!countIn && p.poly && fromUnit === 0) {
      const { n, level } = p.poly;
      for (let j = 0; j < n; j++) {
        const sample = barStart + divRound(j * p.beats * 60 * sr, seg.bpm * seg.q * n);
        out.push({ sample, kind: 'poly', level: muted ? 'mute' : level, bar, beat: j, pulse: 0 });
      }
    }
    out.sort(compareEvents);
    this.queue = out;
    this.qi = 0;
  }

  /** Moves the plan to the next bar (new segment when the tempo changes). */
  private advanceBar(): void {
    const cur = this.plan;
    const p = cur.pattern;
    const nextStart = at(cur.seg, cur.uOffset + p.beats, 1, this.sr);
    const bar = cur.bar + 1;
    const bpm = bar < 0 ? cur.seg.bpm : this.bpmAtBar(p, bar, nextStart, true);
    let seg = cur.seg;
    let uOffset = cur.uOffset + p.beats;
    if (bpm !== seg.bpm) {
      seg = { s0: nextStart, bpm, q: seg.q };
      uOffset = 0;
    }
    const muted = bar >= 0 && isMutedBar(p.mute, bar - this.muteOrigin);
    this.plan = { bar, pattern: p, seg, uOffset, fromUnit: 0, barStart: nextStart, muted };
    this.fillBar();
  }

  next(): MetronomeEvent {
    while (this.qi >= this.queue.length) this.advanceBar();
    const e = this.queue[this.qi++];
    this.lastSample = e.sample;
    return e;
  }

  /** Current pattern (after the latest update was installed). */
  get current(): Pattern {
    return this.pattern;
  }

  /**
   * Installs `next` at the first beat ('beat') or bar ('bar') boundary after the last returned event. A 'beat' edit
   * falls back to the bar line when the meter changes, a polyrhythm is involved, a trainer is running or added, or
   * during the count-in (SPEC §5.5: edits at the next beat, trainer steps at bar lines). Returns the boundary sample.
   */
  update(next: Pattern, at_: 'beat' | 'bar'): number {
    const cur = this.plan;
    const p = cur.pattern;
    const after = this.lastSample;
    const trainerChanged = JSON.stringify(p.trainer ?? null) !== JSON.stringify(next.trainer ?? null);
    const muteChanged = JSON.stringify(p.mute ?? null) !== JSON.stringify(next.mute ?? null);
    const beatOk =
      at_ === 'beat' && sameMeter(p, next) && !p.poly && !next.poly && !p.trainer && !next.trainer && cur.bar >= 0;
    const starts = beatStarts(p);
    if (beatOk) {
      // First counted-beat start in this bar strictly after the last returned event.
      for (let u = Math.max(cur.fromUnit, 0); u < p.beats; u++) {
        if (!starts[u]) continue;
        const s = at(cur.seg, cur.uOffset + u, 1, this.sr);
        if (s > after) return this.install(next, cur.bar, u, s, cur.uOffset, trainerChanged, muteChanged);
      }
    }
    // Next bar line after the last returned event: this bar's start if nothing of it was returned yet, else its end.
    if (cur.fromUnit === 0 && cur.barStart > after) {
      return this.install(next, cur.bar, 0, cur.barStart, cur.uOffset, trainerChanged, muteChanged);
    }
    const barEnd = at(cur.seg, cur.uOffset + p.beats, 1, this.sr);
    return this.install(next, cur.bar + 1, 0, barEnd, cur.uOffset + p.beats, trainerChanged, muteChanged);
  }

  /**
   * Replaces the plan from (bar, fromUnit) at sample `boundary`. Unreturned events of the old plan before the boundary
   * are kept. The old segment continues when tempo and q are unchanged (no re-rounding), else a new one starts.
   */
  private install(
    next: Pattern,
    bar: number,
    fromUnit: number,
    boundary: number,
    continuedOffset: number,
    trainerChanged: boolean,
    muteChanged: boolean
  ): number {
    const keep = this.queue.slice(this.qi).filter((e) => e.sample < boundary);
    this.pattern = next;
    if (bar >= 0 && trainerChanged) this.trainerOrigin = bar;
    if (bar >= 0 && muteChanged) this.muteOrigin = bar;
    const startBpm = next.trainer ? trainerBpmForStep(next.trainer, 0) : next.bpm;
    const bpm = bar < 0 ? startBpm : this.bpmAtBar(next, bar, boundary, fromUnit === 0);
    const q = unitsPerBpmBeat(next);
    const old = this.plan.seg;
    const keepSeg = bpm === old.bpm && q === old.q;
    const seg: Segment = keepSeg ? old : { s0: boundary, bpm, q };
    const uOffset = keepSeg ? continuedOffset : -fromUnit;
    const barStart = fromUnit === 0 ? boundary : this.plan.barStart;
    const muted = bar >= 0 && isMutedBar(next.mute, bar - this.muteOrigin);
    this.plan = { bar, pattern: next, seg, uOffset, fromUnit, barStart, muted };
    this.fillBar();
    this.queue = [...keep, ...this.queue];
    return boundary;
  }
}

/** All events with fromSample ≤ sample < toSample of a pattern started at `startSample` (lazy from the start). */
export function events(pattern: Pattern, sr: number, fromSample: number, toSample: number, startSample = 0): MetronomeEvent[] {
  const s = new Scheduler(pattern, sr, startSample);
  const out: MetronomeEvent[] = [];
  for (;;) {
    const e = s.next();
    if (e.sample >= toSample) return out;
    if (e.sample >= fromSample) out.push(e);
  }
}

/** The first `count` events of a pattern (golden vectors). */
export function firstEvents(pattern: Pattern, sr: number, count: number): MetronomeEvent[] {
  const s = new Scheduler(pattern, sr);
  return Array.from({ length: count }, () => s.next());
}

/** Canonical one-line text of an event (golden-vector checksums; native ports print the same). */
export function eventLine(e: MetronomeEvent): string {
  return `${e.sample},${e.kind},${e.level},${e.bar},${e.beat},${e.pulse}`;
}

/** FNV-1a 32-bit over UTF-8-free ASCII text (event lines are ASCII). Portable to Swift/Kotlin. */
export function fnv1a32(text: string, h = 0x811c9dc5): number {
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Checksum of an event list: FNV-1a over the lines joined with "\n" (each line followed by "\n"). */
export function eventsChecksum(list: MetronomeEvent[]): number {
  let h = 0x811c9dc5;
  for (const e of list) h = fnv1a32(`${eventLine(e)}\n`, h);
  return h;
}
