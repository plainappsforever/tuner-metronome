// Practice log maths (SPEC §5.9). A session = one metronome run from play to stop/auto-stop/interruption; saved when
// its audible time is ≥ 20 s (pauses excluded). Totals: this week (Monday 00:00 local time) and all time, minutes
// rounded down. No streaks, goals or badges.

export const MIN_SESSION_SECONDS = 20;

export type EndedBy = 'user' | 'autostop' | 'interruption' | 'process';

export type PracticeSession = {
  id: string;
  startedAt: number; // ms since epoch
  endedAt: number;
  seconds: number; // audible seconds, integer
  bpmMin: number;
  bpmMax: number;
  presetId: string | null;
  setlistId: string | null;
  endedBy: EndedBy;
};

/** Monday 00:00 local time of the week containing `ms`. */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  const daysSinceMonday = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysSinceMonday).getTime();
}

export type Totals = { weekSeconds: number; allSeconds: number; weekMinutes: number; allMinutes: number };

export function totals(sessions: readonly Pick<PracticeSession, 'startedAt' | 'seconds'>[], now: number): Totals {
  const from = weekStart(now);
  let weekSeconds = 0;
  let allSeconds = 0;
  for (const s of sessions) {
    allSeconds += s.seconds;
    if (s.startedAt >= from && s.startedAt <= now) weekSeconds += s.seconds;
  }
  return { weekSeconds, allSeconds, weekMinutes: Math.floor(weekSeconds / 60), allMinutes: Math.floor(allSeconds / 60) };
}

/**
 * Tracks one run: audible time (play → pause/stop, pauses excluded) and the BPM range heard. Times are monotonic ms;
 * the wall-clock start/end come from the caller.
 */
export class PracticeClock {
  private runningSince: number | null = null;
  private audibleMs = 0;
  private min = Infinity;
  private max = -Infinity;

  start(t: number, bpm: number): void {
    this.runningSince ??= t;
    this.tempo(bpm);
  }

  pause(t: number): void {
    if (this.runningSince !== null) this.audibleMs += Math.max(0, t - this.runningSince);
    this.runningSince = null;
  }

  tempo(bpm: number): void {
    this.min = Math.min(this.min, bpm);
    this.max = Math.max(this.max, bpm);
  }

  /** Stops the clock; returns the integer audible seconds and BPM range, or null if shorter than 20 s. */
  finish(t: number): { seconds: number; bpmMin: number; bpmMax: number } | null {
    this.pause(t);
    const seconds = Math.floor(this.audibleMs / 1000);
    if (seconds < MIN_SESSION_SECONDS || !Number.isFinite(this.min)) return null;
    return { seconds, bpmMin: this.min, bpmMax: this.max };
  }
}
