// Reference tone (SPEC §5.8): sine + 2nd harmonic −12 dB + 3rd harmonic −18 dB; phase accumulator in double
// precision; linear attack 15 ms, linear release 60 ms; fundamental peak −12 dBFS. The native synth implements the
// same recipe; A9 compares both against the target frequency.

export const TONE_ATTACK_S = 0.015;
export const TONE_RELEASE_S = 0.06;
export const TONE_LEVEL = Math.pow(10, -12 / 20);
const H2 = Math.pow(10, -12 / 20);
const H3 = Math.pow(10, -18 / 20);
const TAU = 2 * Math.PI;

export class ToneVoice {
  private phase = 0;
  private age = 0; // frames since start
  private releaseAt = -1; // frame index where release began
  private readonly inc: number;
  private readonly attack: number;
  private readonly release: number;

  readonly hz: number;
  readonly sr: number;
  readonly level: number;

  // No TypeScript parameter properties anywhere in src/engine: Node's type stripping (scripts/ts-hooks.mjs) rejects them.
  constructor(hz: number, sr: number, level = TONE_LEVEL) {
    this.hz = hz;
    this.sr = sr;
    this.level = level;
    this.inc = hz / sr;
    this.attack = Math.max(1, Math.round(TONE_ATTACK_S * sr));
    this.release = Math.max(1, Math.round(TONE_RELEASE_S * sr));
  }

  /** Begin the 60 ms release now. */
  stop(): void {
    if (this.releaseAt < 0) this.releaseAt = this.age;
  }

  get done(): boolean {
    return this.releaseAt >= 0 && this.age >= this.releaseAt + this.release;
  }

  /** Adds `frames` samples into `out` starting at `offset`. */
  render(out: Float32Array, frames = out.length, offset = 0): void {
    for (let i = 0; i < frames; i++) {
      let env = this.age < this.attack ? this.age / this.attack : 1;
      if (this.releaseAt >= 0) {
        const r = this.age - this.releaseAt;
        env *= r >= this.release ? 0 : 1 - r / this.release;
      }
      const p = TAU * this.phase;
      out[offset + i] += this.level * env * (Math.sin(p) + H2 * Math.sin(2 * p) + H3 * Math.sin(3 * p));
      this.phase += this.inc;
      if (this.phase >= 1) this.phase -= 1;
      this.age++;
    }
  }
}

/** Renders a tone of `seconds` (release included at the end) into a new buffer. */
export function renderTone(hz: number, sr: number, seconds: number): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const v = new ToneVoice(hz, sr);
  const releaseFrom = Math.max(0, n - Math.round(TONE_RELEASE_S * sr));
  v.render(out, releaseFrom, 0);
  v.stop();
  v.render(out, n - releaseFrom, releaseFrom);
  return out;
}
