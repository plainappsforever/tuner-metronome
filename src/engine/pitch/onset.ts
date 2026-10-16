// Spectral onset measure (review M2): a new string plucked while another one still rings barely raises the whole
// window's level (two equal plucks 0.5–1 s apart: +4–5 dB, below the 6 dB rule), but nearly all of the new string's
// partials appear in bins where nothing sounded a moment earlier. So each analysis takes the Hann magnitude spectrum
// |X| of the NEWEST ≈ 85 ms of the stream and compares it with the two previous analyses:
//   novelty = Σ max(0, |X|(k) − ref(k)) / Σ |X|(k),  ref(k) = max over k±1 of min(|X|₋₁, |X|₋₂)(k)
// (the minimum over the previous two ignores an attack that was only partly inside the previous segment; the ±1-bin
// maximum stops vibrato and slow glides from counting as new energy), and riseDb = level of the newest segment
// against the quieter of the two previous ones (in the magnitude sum). Measured in fix round 1 (D36): decaying notes,
// vibrato, glides and noise of the tuning set stay below 0.3 or below +1.5 dB; a second pluck over a ringing string at
// equal force gives ≥ 0.48. The tracker decides what counts as an onset (TRACKER.novelty*).
import { realFft } from './fft';

export type OnsetMeasure = { novelty: number; riseDb: number };

/** Bins used: 40 Hz … 6 kHz (below: rumble and hum; above: little energy from strings, mostly noise). */
const LO_HZ = 40;
const HI_HZ = 6000;

export class OnsetDetector {
  readonly n: number;
  private hann: Float64Array;
  private re: Float64Array;
  private im: Float64Array;
  private tmp: Float64Array;
  private prev1: Float64Array | null = null;
  private prev2: Float64Array | null = null;
  private cur: Float64Array;
  private kLo: number;
  private kHi: number;

  /** `n` = newest samples per measurement: 4096 at 48 kHz (≈ 85 ms), scaled with the rate to a power of two. */
  constructor(sr: number) {
    let n = 256;
    while (n < ((4096 * sr) / 48000) * 0.999) n <<= 1;
    this.n = n;
    this.hann = new Float64Array(n);
    for (let i = 0; i < n; i++) this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
    this.re = new Float64Array((n >> 1) + 1);
    this.im = new Float64Array((n >> 1) + 1);
    this.tmp = new Float64Array(n);
    this.kLo = Math.max(1, Math.floor((LO_HZ * n) / sr));
    this.kHi = Math.min((n >> 1) - 1, Math.ceil((HI_HZ * n) / sr));
    this.cur = new Float64Array(this.kHi + 2);
  }

  /** `x` = the newest `n` samples (oldest first). */
  update(x: Float32Array | Float64Array): OnsetMeasure {
    const { n, hann, re, im, tmp, kLo, kHi } = this;
    for (let i = 0; i < n; i++) tmp[i] = x[i] * hann[i];
    realFft(tmp, n, n, re, im);
    const cur = this.cur;
    let total = 0;
    for (let k = kLo; k <= kHi; k++) {
      cur[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]); // magnitude: upper partials count, the fundamental does not dominate
      total += cur[k];
    }
    let novelty = 0;
    let riseDb = 0;
    const p1 = this.prev1;
    const p2 = this.prev2 ?? this.prev1;
    if (p1 && p2) {
      let fresh = 0;
      let e1 = 0;
      let e2 = 0;
      for (let k = kLo; k <= kHi; k++) {
        e1 += p1[k];
        e2 += p2[k];
        let ref = 0;
        for (let j = Math.max(kLo, k - 1); j <= Math.min(kHi, k + 1); j++) ref = Math.max(ref, Math.min(p1[j], p2[j]));
        if (cur[k] > ref) fresh += cur[k] - ref;
      }
      novelty = total > 0 ? fresh / total : 0;
      const before = Math.min(e1, e2);
      riseDb = before > 0 && total > 0 ? 10 * Math.log10(total / before) : total > 0 ? 60 : 0;
    }
    // Rotate: prev2 ← prev1 ← cur, reusing the oldest buffer.
    const spare = this.prev2 ?? new Float64Array(cur.length);
    this.prev2 = this.prev1;
    this.prev1 = cur;
    this.cur = spare;
    return { novelty, riseDb };
  }

  reset(): void {
    this.prev1 = null;
    this.prev2 = null;
  }
}
