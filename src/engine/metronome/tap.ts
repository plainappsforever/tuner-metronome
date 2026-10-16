// Tap tempo (SPEC §5.7, amended in fix round 1 — D36): median of the last up to 4 intervals; reset after 2 s without
// a tap; integer BPM 10–400; first result after 2 taps. Review S8: one bad tap must change nothing —
// - an interval shorter than 150 ms (faster than 400 BPM) is a finger bounce: the tap is ignored;
// - an interval more than 40 % away from the running median only starts a candidate; the tempo switches when the
//   next interval confirms it (within 40 % of the candidate), otherwise the candidate is dropped.
// Consequence of the 2 s reset: tapping covers ≥ 30 BPM; slower tempos use the keypad (D29).
import { BPM_MAX, BPM_MIN } from './pattern';

export const TAP_RESET_MS = 2000;
export const TAP_CHANGE = 0.4;
export const TAP_MIN_INTERVAL_MS = 60000 / BPM_MAX;
const MAX_INTERVALS = 4;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class TapTempo {
  private last: number | null = null;
  private intervals: number[] = [];
  private candidate: number | null = null;

  /** Registers a tap at monotonic time `ms`; returns the BPM, or null until two taps form an interval. */
  tap(ms: number): number | null {
    const last = this.last;
    if (last !== null && ms > last && ms - last < TAP_MIN_INTERVAL_MS) return this.bpm(); // bounce: ignored
    this.last = ms;
    if (last === null || ms - last > TAP_RESET_MS || ms <= last) {
      this.intervals = [];
      this.candidate = null;
      return null;
    }
    const interval = ms - last;
    if (this.intervals.length > 0 && Math.abs(interval - median(this.intervals)) > TAP_CHANGE * median(this.intervals)) {
      const c = this.candidate;
      if (c !== null && Math.abs(interval - c) <= TAP_CHANGE * c) {
        this.intervals = [c]; // confirmed: the new tempo starts from both intervals
        this.candidate = null;
      } else {
        this.candidate = interval;
        return this.bpm();
      }
    } else this.candidate = null;
    this.intervals.push(interval);
    if (this.intervals.length > MAX_INTERVALS) this.intervals.shift();
    return this.bpm();
  }

  private bpm(): number | null {
    if (this.intervals.length === 0) return null;
    return Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(60000 / median(this.intervals))));
  }

  reset(): void {
    this.last = null;
    this.intervals = [];
    this.candidate = null;
  }
}
