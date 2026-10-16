// Pitch detector (SPEC §5.3): MPM / NSDF peak picking with a YIN cross-check, both from one FFT autocorrelation,
// parabolic + multi-period refinement. Mono Float32 window, any sample rate 8–96 kHz. Preallocated per window size:
// no allocation per call after warm-up (except the result object).
import { autocorrelate, realFft } from './fft';

export type DetectOptions = {
  minHz?: number;
  maxHz?: number;
  /** MPM threshold relative to the highest key maximum (tuned only on the tuning set). */
  k?: number;
  /**
   * Per-window one-pole 20 Hz high-pass (SPEC §5.3 step 2). Off by default: starting from zero state in every window
   * it adds a transient that biased sines by up to −14 cents (measured, D32). The 20 Hz high-pass runs on the
   * continuous stream instead (`AnalysisStream`, stream.ts).
   */
  highpass?: boolean;
  /** First-partial band in FFT bins: [flat half-width, total half-width] (tuned only on the tuning set). */
  band?: [number, number];
  /** The window was cut at an onset (no audio from before it, stream.ts): treated like a trimmed window. */
  cut?: boolean;
  /**
   * Octave check (fix round 3, default on). Off for the residual (a previous note combed out): its leftovers sit at that
   * note's partials, so a lower candidate there is the removed note, never a new one.
   */
  octave?: boolean;
};

export type Detection = {
  hz: number | null;
  /** NSDF value of the chosen peak, 0–1. */
  clarity: number;
  rmsDb: number;
  /** Period in samples (fractional), 0 when hz is null. */
  period: number;
  /** YIN cross-check moved the lag by an octave. */
  repaired: boolean;
  /** Final estimate came from the first-partial refinement (else from the NSDF period). */
  firstPartial: boolean;
  /**
   * Energy of the newest eighth of the window relative to the loudest eighth (0–1). Near 0 = the sound already
   * stopped inside the window (a click, a tap); a sustained note or a fresh attack is near 1.
   */
  tail: number;
  /** Leading quiet eighths were cut off (an attack from silence): the estimate is rough (review S3). */
  trimmed: boolean;
  /** Periods held by the analysed (trimmed) window. */
  periods: number;
  /**
   * The first partial was too weak to measure (steep phone-mic roll-off under a bass string): the estimate comes from
   * partials 2 and 3 with their inharmonicity solved (review S5), or from the NSDF period if those fail too.
   */
  weakFundamental: boolean;
  /**
   * Fix round 3 — octave decision (`octaveCheck`): 1 = the MPM pick stood; 1/2 or 1/3 = moved down to a sub-harmonic
   * whose own partials sound (a real lower note whose upper partials dominate: bowed double bass G1 ff read G2, oboe
   * A♯4 read F6); 2 or 3 = moved up because the pick's only own component was a lone low tone (a body resonance or
   * sympathetic string under the note). Absent = 1.
   */
  octaveFix?: number;
  /**
   * Fix round 3: the octave below the reading has some support (its fundamental and an odd partial sound and the
   * window is more periodic at its period) but not enough to move there. The tracker then never picks an
   * instrument string from this reading alone (L26). Absent = false.
   */
  octaveAmbiguous?: boolean;
  /**
   * Fix round 3: the first partial measured alone (before the partial 1…8 fit), when it was measured. The tracker uses
   * it while a click or tap may sit in the window: its broadband energy weighs on the weak upper partials.
   */
  hz1?: number;
};

export const DEFAULTS = { minHz: 27, maxHz: 2200, k: 0.9, band: [3, 4.5] as [number, number] };
export const YIN_BAD = 0.25;
export const YIN_GOOD = 0.1;
export const MULTI_PERIOD_MIN = 0.8;
/**
 * Fix round 3 — octave check thresholds, chosen on the real-recording set 1 (a tuning set since this round) from the
 * ec0bc99 detections of 51,770 analysed frames of 482 recordings: a sub-harmonic f/m replaces the MPM pick f when the
 * window is clearly more periodic at its period ((1 − n(τ)) ≥ R·(1 − n(m·τ)), R = 8 for m = 2, 6 for m = 3) AND f/m's
 * own first partial and one more partial that f does not have are within 30 dB of the strongest spectral line. On the
 * shown frames that moves 335 of 538 octave-high and 39 of 39 twelfth-high frames, and 1 + 2 of 38,339 right ones (a
 * flute and a cello-pizz tail); R = 3 moved 6 right frames (flute E5 over a faint E4: the tube's own sub-octave). The
 * rest is left to the tracker's octave rules. A lone low tone (only the first partial of f, ≥ 6 dB under its 2nd, its
 * odd partials 3–9 more than 35 dB down) gives way to 2f (3f likewise). `presentDb`: `lowerPresent`.
 */
export const OCTAVE = { subRatio: [0, 0, 8, 6], subDb: -30, ambiguousRatio: 1.5, loneDb: -35, loneGap2Db: 6, loneGap3Db: 3, presentDb: -40, maxHz: 6000 };
/**
 * Fix round 3 — first partial from partials 1…8 (`multiPartial`). Measured on real-recording set 1 (a tuning set since
 * this round) against the first partial measured alone: piano p95 9.4 → 3.7 c, pizzicato 16.3 → 7.2 c, steady bowed/wind
 * 3.7 → 2.7 c, steady-display jumps 75 → 15; tuning set A1 40–1000 Hz p95 0.170 → 0.094 c, 1000–2100 Hz 0.012 → 0.094 c
 * (limit 2.0). Amplitude weights (power weights: piano p95 3.6 c, all recordings 3.25 vs 3.24 c). `keepB`: the B term is
 * kept only when it halves the weighted residual (bowed and blown tones are exactly harmonic). Tried and dropped:
 * leaving out partials > 25 dB under the strongest, or more than 2/5 c off the fitted law (more display jumps on real
 * notes, clicks not fixed). A click in the window is handled by the tracker, which takes the first partial alone (`hz1`).
 */
export const MULTI = { partials: 8, maxHz: 5000, maxB: 0.005, maxDevCents: 20, keepB: 0.5 };
const HIGHPASS_HZ = 20;
const SILENCE_RMS = 1e-7;

type Buffers = {
  w: number;
  x: Float64Array;
  r: Float64Array;
  nsdf: Float64Array;
  yin: Float64Array;
  tapered: Float64Array;
  hann: Float64Array;
  specRe: Float64Array;
  specIm: Float64Array;
};

function parabola(a: number, b: number, c: number): { delta: number; value: number } {
  const den = a - 2 * b + c;
  if (den === 0) return { delta: 0, value: b };
  const delta = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
  return { delta, value: b - 0.25 * (a - c) * delta };
}

export class PitchDetector {
  private buf: Buffers | null = null;
  private cache = new Map<number, Buffers>(); // per window size: windows cut at an onset vary in length
  private lastLen = 0; // valid NSDF lags of the last call
  // Spectrum of the last analysed part (fix round 3: computed once per call, used by the octave check and step 8).
  private specN = 1;
  private specLen = 1;
  private specSr = 48000;
  private specMax = 0;

  private buffers(w: number): Buffers {
    if (this.buf?.w === w) return this.buf;
    const cached = this.cache.get(w);
    if (cached) return (this.buf = cached);
    const half = (w >> 1) + 2;
    const hann = new Float64Array(w);
    for (let i = 0; i < w; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / w);
    this.buf = {
      w,
      x: new Float64Array(w),
      r: new Float64Array(w),
      nsdf: new Float64Array(half),
      yin: new Float64Array(half),
      tapered: new Float64Array(w),
      hann,
      specRe: new Float64Array((w >> 1) + 1),
      specIm: new Float64Array((w >> 1) + 1),
    };
    this.cache.set(w, this.buf);
    return this.buf;
  }

  /** NSDF value of the last analysis at a (fractional) lag: the local maximum within ±2 samples, or −1. */
  nsdfNear(lag: number): number {
    if (!this.buf) return -1;
    const c = Math.round(lag);
    let best = -1;
    for (let t = c - 2; t <= c + 2; t++) if (t >= 1 && t < this.lastLen) best = Math.max(best, this.buf.nsdf[t]);
    return best;
  }

  detect(window: Float32Array | Float64Array, sampleRate: number, opts: DetectOptions = {}): Detection {
    const minHz = opts.minHz ?? DEFAULTS.minHz;
    const maxHz = opts.maxHz ?? DEFAULTS.maxHz;
    const k = opts.k ?? DEFAULTS.k;
    const full = window.length;
    const { x, r, nsdf, yin } = this.buffers(full);
    let w = full;

    // 1–3. Remove DC, one-pole high-pass at 20 Hz, level.
    let mean = 0;
    for (let i = 0; i < w; i++) mean += window[i];
    mean /= w;
    const a = opts.highpass ? 1 / (1 + (2 * Math.PI * HIGHPASS_HZ) / sampleRate) : 0;
    let prevIn = window[0] - mean;
    let prevOut = 0;
    let energy = 0;
    for (let i = 0; i < w; i++) {
      const v = window[i] - mean;
      prevOut = a ? a * (prevOut + v - prevIn) : v;
      prevIn = v;
      x[i] = prevOut;
      energy += prevOut * prevOut;
    }
    const rms = Math.sqrt(energy / w);
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -200;
    this.lastLen = 0;
    // Temporal shape: energy per eighth of the window.
    const seg = w >> 3;
    let maxSeg = 0;
    let lastSeg = 0;
    for (let s0 = 0; s0 < 8; s0++) {
      let e = 0;
      for (let i = s0 * seg; i < (s0 + 1) * seg; i++) e += x[i] * x[i];
      if (e > maxSeg) maxSeg = e;
      if (s0 === 7) lastSeg = e;
    }
    const tail = maxSeg > 0 ? lastSeg / maxSeg : 0;
    const none = (clarity = 0, trimmed = false): Detection => ({ hz: null, clarity, rmsDb, period: 0, repaired: false, firstPartial: false, tail, trimmed, periods: 0, weakFundamental: false, octaveFix: 1, octaveAmbiguous: false });
    if (rms < SILENCE_RMS) return none();

    // Leading quiet part (D33): right after an onset most of the window is still the silence before the note, and
    // sample pairs straddling the onset only add to m(τ), so the clarity of a clean note drops to ≈ 0.8. Eighths
    // before the first one within 20 dB of the loudest are cut off (at most ¾ of the window).
    let start = 0;
    for (let s0 = 0; s0 < 6; s0++) {
      let e = 0;
      for (let i = s0 * seg; i < (s0 + 1) * seg; i++) e += x[i] * x[i];
      if (e >= 0.01 * maxSeg) break;
      start = (s0 + 1) * seg;
    }
    if (start > 0) {
      w = full - start;
      let m2 = 0;
      for (let i = 0; i < w; i++) m2 += x[start + i];
      m2 /= w;
      for (let i = 0; i < w; i++) x[i] = x[start + i] - m2;
    }
    let n2 = 1;
    while (n2 < 2 * w) n2 <<= 1;

    // 4. NSDF n(τ) = 2 r(τ) / m(τ) for τ = 0 … W/2, m(τ) = Σ over the overlap of x_j² + x_{j+τ}² (incremental).
    autocorrelate(x, w, n2, r);
    const half = w >> 1;
    let m = 2 * r[0];
    let cum = 0; // Σ_{j=1}^{τ} d(j) for YIN
    nsdf[0] = 1;
    yin[0] = 1;
    for (let t = 1; t <= half; t++) {
      m -= x[t - 1] * x[t - 1] + x[w - t] * x[w - t];
      nsdf[t] = m > 0 ? (2 * r[t]) / m : 0;
      const d = Math.max(0, m - 2 * r[t]);
      cum += d;
      yin[t] = cum > 0 ? (d * t) / cum : 1;
    }
    this.lastLen = half + 1;
    const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
    const tauMax = Math.min(Math.ceil(sampleRate / minHz), half - 1);
    if (tauMax <= tauMin + 2) return none(0, start > 0 || opts.cut === true);

    // 5. MPM key maxima: the maximum of each positive region after the first negative-going zero crossing.
    let t = 1;
    while (t < tauMax && nsdf[t] > 0) t++;
    let chosen = -1;
    let highest = 0;
    // Two passes: the highest key maximum in range, then the first one ≥ k · highest.
    for (let pass = 0; pass < 2 && chosen < 0; pass++) {
      let i = t;
      while (i < tauMax) {
        while (i < tauMax && nsdf[i] <= 0) i++;
        let peak = -1;
        let peakValue = -Infinity;
        while (i <= tauMax && nsdf[i] > 0) {
          if (nsdf[i] > peakValue) {
            peakValue = nsdf[i];
            peak = i;
          }
          i++;
        }
        if (peak < 0 || peak < tauMin || peak >= tauMax) continue;
        if (pass === 0) highest = Math.max(highest, peakValue);
        else if (peakValue >= k * highest) {
          chosen = peak;
          break;
        }
      }
      if (pass === 0 && highest <= 0) break;
    }
    if (chosen < 0) return none(Math.max(0, highest), start > 0 || opts.cut === true);

    // 6. YIN cross-check: a poor d′ at τ with a clearly good d′ at 2τ or τ/2 → octave repair.
    let repaired = false;
    const localMin = (c: number) => {
      let best = Infinity;
      let at = -1;
      for (let j = Math.max(1, c - 2); j <= Math.min(half, c + 2); j++) {
        if (yin[j] < best) {
          best = yin[j];
          at = j;
        }
      }
      return { best, at };
    };
    const localMaxNsdf = (c: number) => {
      let best = -Infinity;
      let at = -1;
      for (let j = Math.max(1, c - 2); j <= Math.min(half - 1, c + 2); j++) {
        if (nsdf[j] > best) {
          best = nsdf[j];
          at = j;
        }
      }
      return { best, at };
    };
    if (yin[chosen] > YIN_BAD) {
      const down = 2 * chosen <= tauMax ? localMin(2 * chosen) : { best: Infinity, at: -1 };
      const up = Math.round(chosen / 2) >= tauMin ? localMin(Math.round(chosen / 2)) : { best: Infinity, at: -1 };
      const target = down.best < YIN_GOOD ? down : up.best < YIN_GOOD ? up : null;
      if (target) {
        const p = localMaxNsdf(target.at);
        if (p.at > 1 && p.at < half - 1) {
          chosen = p.at;
          repaired = true;
        }
      }
    }

    // 6b. Octave check (fix round 3) on the Hann spectrum of the analysed part (computed once; step 8 reuses it).
    this.spectrum(w, sampleRate);
    const oct = opts.octave === false ? { lag: chosen, fix: 1, ambiguous: false } : this.octaveCheck(chosen, tauMin, tauMax, half, sampleRate);
    chosen = oct.lag;

    // 7. Parabolic interpolation, then multi-period refinement at the largest usable multiple q.
    const p1 = parabola(nsdf[chosen - 1], nsdf[chosen], nsdf[chosen + 1]);
    let period = chosen + p1.delta;
    // A trimmed window holding fewer than 3.5 periods gives a rough estimate: lower its clarity so the tracker's gate
    // waits for the next frame instead of flashing a reading that is tens of cents off (D33).
    const periodsHeld = w / period;
    const trimmed = start > 0 || opts.cut === true;
    const clarity = Math.min(1, p1.value) * (trimmed && periodsHeld < 3.5 ? periodsHeld / 3.5 : 1);
    const qMax = Math.floor((half - 2) / period);
    for (let q = qMax; q >= 2; q--) {
      const c = q * period;
      const span = Math.min(Math.floor(period / 3), 2 + Math.ceil(0.15 * q));
      const lo = Math.max(2, Math.floor(c - span));
      const hi = Math.min(half - 2, Math.ceil(c + span));
      let at = -1;
      let best = -Infinity;
      for (let j = lo; j <= hi; j++) {
        if (nsdf[j] > best) {
          best = nsdf[j];
          at = j;
        }
      }
      if (at <= lo || at >= hi || best < MULTI_PERIOD_MIN * clarity) continue;
      const pq = parabola(nsdf[at - 1], nsdf[at], nsdf[at + 1]);
      period = (at + pq.delta) / q;
      break;
    }
    const nsdfHz = sampleRate / period;
    const fp = this.firstPartial(nsdfHz, sampleRate, opts.band ?? DEFAULTS.band, w);
    const octave = { octaveFix: oct.fix, octaveAmbiguous: oct.ambiguous };
    if (fp !== null) return { hz: fp.hz, clarity, rmsDb, period: sampleRate / fp.hz, repaired, firstPartial: !fp.weak, tail, trimmed, periods: periodsHeld, weakFundamental: fp.weak, ...octave, ...(fp.hz1 !== undefined ? { hz1: fp.hz1 } : {}) };
    return { hz: nsdfHz, clarity, rmsDb, period, repaired, firstPartial: false, tail, trimmed, periods: periodsHeld, weakFundamental: false, ...octave };
  }

  /** Hann spectrum of the analysed part x[0..len) into specRe/specIm (FFT size = next power of two, zero padded). */
  private spectrum(len: number, sr: number): void {
    const { w: full, x, tapered, hann, specRe, specIm } = this.buf as Buffers;
    let n = 1;
    while (n < len) n <<= 1;
    for (let i = 0; i < len; i++) tapered[i] = x[i] * (len === full ? hann[i] : 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / len));
    realFft(tapered, len, n, specRe, specIm);
    this.specN = n;
    this.specLen = len;
    this.specSr = sr;
    const bin = sr / n;
    let mx = 0;
    for (let k = Math.max(1, Math.ceil(30 / bin)); k < Math.min((n >> 1) - 1, OCTAVE.maxHz / bin); k++) mx = Math.max(mx, specRe[k] * specRe[k] + specIm[k] * specIm[k]);
    this.specMax = mx;
  }

  /** Strongest spectral line (dB re the strongest one, 30–6000 Hz) within the band a partial of a note `spacing` Hz apart may occupy. */
  private peakDb(hz: number, spacing: number): number {
    const { specRe, specIm } = this.buf as Buffers;
    const bin = this.specSr / this.specN;
    const hw = Math.max(0.2 * spacing, 1.5 * bin);
    if (!(this.specMax > 0) || hz + hw > Math.min(OCTAVE.maxHz, this.specSr / 2 - 2 * bin) || hz - hw < bin) return -Infinity;
    let m = 0;
    for (let k = Math.max(1, Math.round((hz - hw) / bin)); k <= Math.round((hz + hw) / bin); k++) m = Math.max(m, specRe[k] * specRe[k] + specIm[k] * specIm[k]);
    return 10 * Math.log10(m / this.specMax + 1e-15);
  }

  /**
   * Fix round 3 (tracker octave continuity): the last analysed window still holds the note `hz` itself — its first
   * partial, or a partial its k-th partial lacks (j·hz, j not a multiple of k, j ≤ 9), within 40 dB of the strongest
   * line. True when the spectrum cannot separate the partials (no evidence against the note).
   */
  lowerPresent(hz: number, k: number): boolean {
    if (!this.buf || !(hz > 0) || !this.resolves(hz)) return true;
    for (let j = 1; j <= 9; j++) if (j % k !== 0 && this.peakDb(j * hz, hz) >= OCTAVE.presentDb) return true;
    return false;
  }

  /**
   * Fix round 3 (tracker octave continuity): a note `hz` sounds in the last analysed window with its own first partial
   * and another partial that its k-th partial lacks, both within 30 dB of the strongest line (the octave check's
   * sub-harmonic test without the periodicity part). False when the spectrum cannot separate the partials.
   */
  noteSounds(hz: number, k: number): boolean {
    if (!this.buf || !(hz > 0) || !this.resolves(hz) || this.peakDb(hz, hz) < OCTAVE.subDb) return false;
    for (let j = 2; j <= 9; j++) if (j % k !== 0 && this.peakDb(j * hz, hz) >= OCTAVE.subDb) return true;
    return false;
  }

  /** Fix round 3: level of the line at `hz` (a note's first partial) in the last analysed window, dB re the strongest line. */
  partialDb(hz: number): number {
    if (!this.buf || !(hz > 0) || !this.resolves(hz)) return -Infinity;
    return this.peakDb(hz, hz);
  }

  /** The spectrum separates partials `spacing` Hz apart (band + Hann main lobe of the analysed length). */
  private resolves(spacing: number): boolean {
    const bin = this.specSr / this.specN;
    return spacing >= Math.max(0.2 * spacing, 1.5 * bin) + (2 * this.specSr) / this.specLen;
  }

  /**
   * Fix round 3 — the octave decision (real-recording set 1: double-bass G1 ff → G2, G♯1 → G♯2, oboe A♯4 → F6 and
   * F5 → F6 for whole notes; B2 pizz → B1 and A2 → A0 in tails). MPM takes the first NSDF key maximum ≥ 0.9 × the
   * highest, which is the partial when a real low note's upper partials dominate (n(τ) ≈ 0.90 vs n(2τ) ≈ 1.00).
   * (a) The pick moves to m·τ (m = 2, 3) when the window is clearly more periodic there AND the lower note f/m has
   * its own first partial and another partial f lacks (k·f/m, k not a multiple of m) within 30 dB of the strongest
   * line — a second sound an octave below (a sympathetic string, the body) has no such partial; two strings a fifth
   * apart lack the common fundamental. (b) The pick moves to τ/m when f's only own component is a lone low tone: f
   * itself ≥ 6 dB (m = 3: 3 dB) under the m-th partial and the partials of f that m·f lacks (up to 9f) > 35 dB down.
   * Only when the spectrum resolves the candidate's partials (spacing ≥ band + Hann main lobe).
   */
  private octaveCheck(chosen: number, tauMin: number, tauMax: number, half: number, sr: number): { lag: number; fix: number; ambiguous: boolean } {
    const nsdf = (this.buf as Buffers).nsdf;
    const n1 = nsdf[chosen];
    const f = sr / chosen;
    let ambiguous = false;
    for (const m of [2, 3]) {
      const c = m * chosen;
      const lo = c - m - 1;
      const hi = c + m + 1;
      if (hi > Math.min(tauMax, half - 2)) continue;
      let at = -1;
      let nm = -Infinity;
      for (let j = lo; j <= hi; j++) {
        if (nsdf[j] > nm) {
          nm = nsdf[j];
          at = j;
        }
      }
      if (at <= lo || at >= hi || !(nm > n1)) continue;
      const x = sr / at;
      if (!this.resolves(x) || this.peakDb(x, x) < OCTAVE.subDb) continue;
      let own = false;
      for (let k = 2; k <= 9 && !own; k++) if (k % m !== 0 && this.peakDb(k * x, x) >= OCTAVE.subDb) own = true;
      if (!own) continue;
      if (1 - n1 >= OCTAVE.subRatio[m] * (1 - nm)) return { lag: at, fix: 1 / m, ambiguous: false };
      if (m === 2 && 1 - n1 >= OCTAVE.ambiguousRatio * (1 - nm)) ambiguous = true;
    }
    if (f > 1200 || !this.resolves(f)) return { lag: chosen, fix: 1, ambiguous };
    const p1 = this.peakDb(f, f);
    for (const m of [2, 3]) {
      const pm = this.peakDb(m * f, f);
      const gap = m === 2 ? OCTAVE.loneGap2Db : OCTAVE.loneGap3Db;
      let below = p1;
      for (let k = 2; k < m; k++) below = Math.max(below, this.peakDb(k * f, f));
      if (!(below < pm - gap)) continue;
      let others = -Infinity;
      let counted = 0;
      for (let k = m + 1; k <= 9; k++) {
        if (k % m === 0) continue;
        const p = this.peakDb(k * f, f);
        if (p === -Infinity) continue;
        counted++;
        others = Math.max(others, p);
      }
      if (counted < 2 || others >= OCTAVE.loneDb) continue;
      const c = Math.round(chosen / m);
      let at = -1;
      let best = -Infinity;
      for (let j = Math.max(tauMin, c - 2); j <= c + 2; j++) {
        if (nsdf[j] > best) {
          best = nsdf[j];
          at = j;
        }
      }
      if (at > Math.max(tauMin, c - 2) && at < c + 2 && best >= 0.5) return { lag: at, fix: m, ambiguous: false };
    }
    return { lag: chosen, fix: 1, ambiguous };
  }

  /**
   * 8. First-partial refinement (D32): inharmonic strings stretch their upper partials (f_k = k·f1·√((1+Bk²)/(1+B))),
   * so the NSDF period is a blend that reads sharp; a tuner's target is the first partial. The Hann-tapered window's
   * spectrum is passed through a flat band around the estimate (±3 bins flat with cos² edges to ±4.5 bins, never wider
   * than ±½·f0 so the neighbouring partials stay out), shifted to baseband and evaluated as an analytic signal at 48
   * points of the central 80 % of the window; the frequency is the magnitude-weighted mean phase advance, re-centred
   * once on its own result. Used when the band holds ≥ 0.1 % of the window's spectral energy and the result lies within
   * 50 cents of the NSDF estimate.
   * Weak first partial (S5, a steep phone-mic roll-off under E1/B0): partials 2 and 3 are measured the same way and the
   * string law is solved for f1 and B: (2·f3 / 3·f2)² = (1+9B)/(1+4B), f1 = f2 / (2·√((1+4B)/(1+B))).
   * Otherwise null (the NSDF estimate stands, e.g. a missing-fundamental tone whose partials 2/3 are weak as well).
   */
  private firstPartial(f0: number, sr: number, bandBins: [number, number], len: number): { hz: number; weak: boolean; hz1?: number } | null {
    const { specRe, specIm } = this.buf as Buffers;
    const w = this.specN; // FFT size of the analysed part (spectrum() ran in step 6b on the same `len`)
    let total = 0;
    for (let k = 1; k < w >> 1; k++) total += specRe[k] * specRe[k] + specIm[k] * specIm[k];
    if (total <= 0) return null;
    // Fix round 2: a fundamental more than 20 dB below the 2nd partial is not measured either (missing-fundamental
    // tones read up to −46 c from leakage in a window cut at the attack; a phone mic's roll-off under a bass string is
    // the same case): partials 2 and 3 serve.
    const near = (c: number) => {
      const half = Math.min(bandBins[1] * (sr / w), 0.5 * f0);
      let e = 0;
      for (let k = Math.max(1, Math.ceil((c - half) / (sr / w))); k <= Math.min((w >> 1) - 1, Math.floor((c + half) / (sr / w))); k++) e += specRe[k] * specRe[k] + specIm[k] * specIm[k];
      return e;
    };
    const f1 = near(f0) < 0.01 * near(2 * f0) ? 'weak' : this.partial(f0, f0, sr, w, len, bandBins, total);
    if (typeof f1 === 'number') return { hz: this.multiPartial(f1, sr, w, len, bandBins, total), weak: false, hz1: f1 };
    if (f1 !== 'weak') return f1 === null ? null : { hz: f1, weak: false };
    const f2 = this.partial(2 * f0, f0, sr, w, len, bandBins, total);
    if (f2 === null || f2 === 'weak') return null;
    const f3 = this.partial(3 * f0, f0, sr, w, len, bandBins, total);
    let hz: number;
    if (f3 === null || f3 === 'weak') hz = f2 / 2;
    else {
      const rho = Math.pow((2 * f3) / (3 * f2), 2);
      const b = (rho - 1) / (9 - 4 * rho);
      hz = b > 0 && b < 0.01 ? f2 / (2 * Math.sqrt((1 + 4 * b) / (1 + b))) : (f2 / 2 + f3 / 3) / 2;
    }
    return Math.abs(1200 * Math.log2(hz / f0)) > 50 ? null : { hz, weak: true };
  }

  /** Band energy of the last `partial` measurement (its weight in `multiPartial`). */
  private lastBand = 0;

  /**
   * Fix round 3 — the first partial from the note's partials 1…8 (≤ 5 kHz), each measured like the first one (band
   * phase advance, `partial`): f_k / k = f1·(1 + B·(k² − 1)/2) (the stiff-string law for small B), amplitude-weighted
   * least squares for f1 and B, B searched in [0, 0.005) once three partials are measured (else, or outside that range,
   * the harmonic model B = 0: the weighted mean of f_k / k). The first partial alone wandered on real notes whose first
   * partial is weak or beats (piano unison strings, double-bass pizzicato: up to +16 c for 0.3 s while partials 2–8
   * stayed put); the reference of real set 1 (`truth.json` method A) is the same kind of fit. Kept within 20 c of the
   * first partial's own estimate (else that estimate stands).
   */
  private multiPartial(f1: number, sr: number, w: number, len: number, bandBins: [number, number], total: number): number {
    const ks = [1];
    const ys = [f1];
    const ws = [Math.sqrt(this.lastBand)];
    let B = 0;
    for (let k = 2; k <= MULTI.partials; k++) {
      const pred = k * f1 * Math.sqrt((1 + B * k * k) / (1 + B));
      if (pred + 0.5 * f1 > Math.min(MULTI.maxHz, sr / 2)) break;
      const fk = this.partial(pred, f1, sr, w, len, bandBins, total);
      if (typeof fk !== 'number') continue;
      ks.push(k);
      ys.push(fk / k);
      ws.push(Math.sqrt(this.lastBand));
      if (ks.length >= 3) B = Math.max(0, Math.min(MULTI.maxB, this.fitB(ks, ys, ws).B));
    }
    if (ks.length < 2) return f1;
    const model = this.model(ks, ys, ws);
    return Math.abs(1200 * Math.log2(model.a / f1)) <= MULTI.maxDevCents ? model.a : f1;
  }

  /**
   * The stiff-string fit when three or more partials allow it, B lands in [0, 0.005) and the B term explains the
   * partials clearly better than the harmonic model (weighted residual ≤ MULTI.keepB × the harmonic one's); else the
   * harmonic model (B = 0, weighted mean of f_k / k). A bowed or blown tone is exactly harmonic (mode-locked): a small
   * B fitted to noise lowered its first partial (cello D3 diminuendo −5 c, real set 1 `053`).
   */
  private model(ks: number[], ys: number[], ws: number[]): { a: number; B: number } {
    let sw = 0;
    let sy = 0;
    for (let i = 0; i < ks.length; i++) {
      sw += ws[i];
      sy += ws[i] * ys[i];
    }
    const mean = sy / sw;
    const fit = ks.length >= 3 ? this.fitB(ks, ys, ws) : null;
    if (fit === null || !(fit.B >= 0 && fit.B < MULTI.maxB)) return { a: mean, B: 0 };
    let r0 = 0;
    let r1 = 0;
    for (let i = 0; i < ks.length; i++) {
      r0 += ws[i] * (ys[i] - mean) ** 2;
      r1 += ws[i] * (ys[i] - fit.a * (1 + (fit.B * (ks[i] * ks[i] - 1)) / 2)) ** 2;
    }
    return r1 <= MULTI.keepB * r0 ? fit : { a: mean, B: 0 };
  }

  /** Weighted least squares of y = a + b·x, x = (k² − 1)/2; B = b / a. */
  private fitB(ks: number[], ys: number[], ws: number[]): { a: number; B: number } {
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < ks.length; i++) {
      const x = (ks[i] * ks[i] - 1) / 2;
      sw += ws[i];
      sx += ws[i] * x;
      sy += ws[i] * ys[i];
      sxx += ws[i] * x * x;
      sxy += ws[i] * x * ys[i];
    }
    const den = sw * sxx - sx * sx;
    if (!(den > 0)) return { a: sy / sw, B: 0 };
    const b = (sw * sxy - sx * sy) / den;
    const a = (sy - b * sx) / sw;
    return { a, B: b / a };
  }

  /** Half width (Hz) of a band around `centre` that leaves out other peaks ≥ −30 dB of the partial (see `partial`). */
  private clearBand(centre: number, half: number, lobe: number, bin: number, w: number): number {
    const { specRe, specIm } = this.buf as Buffers;
    const mag = (k: number) => specRe[k] * specRe[k] + specIm[k] * specIm[k];
    const kMax = (w >> 1) - 2;
    let peak = 0;
    for (let k = Math.max(1, Math.floor((centre - lobe) / bin)); k <= Math.min(kMax, Math.ceil((centre + lobe) / bin)); k++) peak = Math.max(peak, mag(k));
    if (peak <= 0) return half;
    let out = half;
    const kA = Math.max(2, Math.ceil((centre - half - lobe) / bin));
    const kB = Math.min(kMax, Math.floor((centre + half + lobe) / bin));
    for (let k = kA; k <= kB; k++) {
      const d = Math.abs(k * bin - centre);
      if (d <= 1.5 * lobe) continue;
      const m = mag(k);
      if (m >= 1e-3 * peak && m > mag(k - 1) && m >= mag(k + 1)) out = Math.min(out, Math.max(1.25 * lobe, d - lobe));
    }
    return out;
  }

  /** Band measurement of the partial near `centre` (neighbouring partials `spacing` Hz away); 'weak' = too little energy. */
  private partial(centre0: number, spacing: number, sr: number, w: number, len: number, bandBins: [number, number], total: number): number | null | 'weak' {
    const { specRe, specIm } = this.buf as Buffers;
    const bin = sr / w;
    let centre = centre0;
    const lobe = (2 * sr) / len; // Hann main-lobe half width (Hz) of the analysed length
    for (let iter = 0; iter < 2; iter++) {
      let half = Math.min(bandBins[1] * bin, 0.5 * spacing);
      // The band must hold the partial's whole main lobe: a narrower one biased D1 in a 3-period window by +35…+48 c
      // (fix round 2, blind set 1 `148`/`155`); then the NSDF period stands.
      if (half < 1.25 * lobe) return null;
      // Fix round 2: another sound's peak inside the band (a second string 20 dB down, a fifth away) pulled the estimate
      // by 2–3 c: the band ends one main lobe before the nearest such peak (≥ −30 dB of the partial), never inside the
      // partial's own lobe.
      half = this.clearBand(centre, half, lobe, bin, w);
      const flat = Math.min(bandBins[0] * bin, 0.6 * half);
      const kLo = Math.max(1, Math.ceil((centre - half) / bin));
      const kHi = Math.min((w >> 1) - 1, Math.floor((centre + half) / bin));
      if (kHi - kLo < 2) return null;
      const k0 = Math.round(centre / bin);
      let band = 0;
      for (let k = kLo; k <= kHi; k++) band += specRe[k] * specRe[k] + specIm[k] * specIm[k];
      if (band < 1e-3 * total) return 'weak';
      this.lastBand = band;
      // Baseband analytic signal z(t) = Σ_k X[k]·g(k)·e^{2πi(k−k0)t/w} at t = i·step.
      const points = 48;
      const step = (0.8 * len) / points;
      let sumW = 0;
      let sumPhi = 0;
      let prevRe = 0;
      let prevIm = 0;
      for (let i = 0; i < points; i++) {
        const t = 0.1 * len + (i + 0.5) * step;
        let zr = 0;
        let zi = 0;
        for (let k = kLo; k <= kHi; k++) {
          const d = Math.abs(k * bin - centre);
          if (d >= half) continue;
          const g = d <= flat ? 1 : Math.cos((0.5 * Math.PI * (d - flat)) / (half - flat)) ** 2;
          const ang = (2 * Math.PI * (k - k0) * t) / w;
          const c = Math.cos(ang);
          const s = Math.sin(ang);
          zr += g * (specRe[k] * c - specIm[k] * s);
          zi += g * (specRe[k] * s + specIm[k] * c);
        }
        if (i > 0) {
          const pr = zr * prevRe + zi * prevIm; // z_i · conj(z_{i−1})
          const pi = zi * prevRe - zr * prevIm;
          const mag = Math.hypot(pr, pi);
          if (mag > 0) {
            sumPhi += Math.atan2(pi, pr) * mag;
            sumW += mag;
          }
        }
        prevRe = zr;
        prevIm = zi;
      }
      if (sumW <= 0) return null;
      const hz = k0 * bin + ((sumPhi / sumW) * sr) / (2 * Math.PI * step);
      if (!(hz > 0) || Math.abs(1200 * Math.log2(hz / centre0)) > 50) return null;
      centre = hz;
    }
    return centre;
  }
}

/** Window size for a sample rate: 4096 at 48 kHz (≈ 85 ms) scaled to the next power of two; doubled in low mode. */
export function windowSize(sampleRate: number, low: boolean): number {
  const target = (4096 * sampleRate) / 48000;
  let w = 256;
  while (w < target * 0.999) w <<= 1;
  return low ? w * 2 : w;
}
