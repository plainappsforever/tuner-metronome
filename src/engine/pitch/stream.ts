// From PCM to tuner states: a stateful 20 Hz high-pass on the continuous stream (D32: per-window filtering biased the
// detector), a ring buffer of the newest samples, and the engine that analyses at a fixed signal-time hop.
import { PitchDetector, windowSize, type DetectOptions, type Detection } from './detect';
import { OnsetDetector } from './onset';
import { Tracker, TRACKER, type TrackerConfig, type TunerState } from './tracker';

const HIGHPASS_HZ = 20;

export class AnalysisStream {
  readonly sr: number;
  private ring: Float32Array;
  private write = 0;
  private count = 0;
  private a: number;
  private prevIn = 0;
  private prevOut = 0;
  private scratch = new Map<number, Float32Array>();

  constructor(sr: number, capacity = 1 << 15) {
    this.sr = sr;
    this.ring = new Float32Array(capacity);
    this.a = 1 / (1 + (2 * Math.PI * HIGHPASS_HZ) / sr);
  }

  get capacity(): number {
    return this.ring.length;
  }

  /** Samples pushed so far (signal time = total / sr). */
  get total(): number {
    return this.count;
  }

  push(samples: Float32Array | Float64Array): void {
    const ring = this.ring;
    const n = ring.length;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      this.prevOut = this.a * (this.prevOut + v - this.prevIn);
      this.prevIn = v;
      ring[this.write] = this.prevOut;
      this.write = (this.write + 1) % n;
    }
    this.count += samples.length;
  }

  /** The newest `w` samples (oldest first), zeros where the stream is shorter. Reuses one buffer per size. */
  window(w: number): Float32Array {
    if (w > this.ring.length) throw new Error(`window ${w} exceeds ring ${this.ring.length}`);
    let out = this.scratch.get(w);
    if (!out) this.scratch.set(w, (out = new Float32Array(w)));
    const n = this.ring.length;
    const have = Math.min(w, this.count);
    out.fill(0, 0, w - have);
    let src = (this.write - have + n) % n;
    for (let i = w - have; i < w; i++) {
      out[i] = this.ring[src];
      src = src + 1 === n ? 0 : src + 1;
    }
    return out;
  }
}

/** Analyses per second of signal time — fixed, whatever the display rate (review S1). */
export const ANALYSIS_RATE = 30;
const ONSET_BLOCK = 256;
/** Windows cut at an onset: at least 1024 samples, lengths in steps of 512 (few distinct sizes, buffers reused). */
const CUT_MIN = 1024;
const CUT_STEP = 512;

/**
 * Detector + tracker on a stream. `push` PCM as it arrives (any chunk size); the engine analyses at a fixed hop of
 * signal time (sr/30 samples), so a 30, 60 or 120 Hz UI loop gets the same readings. `push` returns the newest state
 * (null when no analysis was due). If more than `maxPerPush` analyses are due at once (the JS thread stalled), only
 * the newest ones run.
 */
export class TunerEngine {
  readonly stream: AnalysisStream;
  readonly detector = new PitchDetector();
  readonly tracker: Tracker;
  readonly hop: number;
  private residualDetector = new PitchDetector();
  private lowCutDetector = new PitchDetector();
  private lowCutBuf = new Map<number, Float64Array>();
  /** Analyses that ran the low-cut detector too (cost accounting for P3). */
  lowCutRuns = 0;
  private onset: OnsetDetector;
  private opts: DetectOptions;
  private sinceAnalysis = 0;
  private comb = new Map<number, Float64Array>();
  private window: Float32Array | null = null;
  /** Stream sample where the current note's attack begins (located after each onset); windows never reach before it. */
  private onsetSample = -Infinity;
  /** Attack position before the last located one: restored when that onset turns out to be a transient (fix round 2). */
  private prevOnsetSample = -Infinity;
  private warmUp: number;
  /** Analyses that ran the residual detector too (cost accounting for P3). */
  residualRuns = 0;
  analyses = 0;

  constructor(sr: number, config: TrackerConfig, opts: DetectOptions = {}, hop = Math.round(sr / ANALYSIS_RATE)) {
    this.stream = new AnalysisStream(sr);
    this.tracker = new Tracker(config);
    this.opts = opts;
    this.hop = hop;
    this.onset = new OnsetDetector(sr);
    this.warmUp = windowSize(sr, false);
  }

  push(samples: Float32Array | Float64Array, maxPerPush = 8): TunerState | null {
    let at = 0;
    let due = Math.floor((this.sinceAnalysis + samples.length) / this.hop);
    let last: TunerState | null = null;
    while (at < samples.length) {
      const take = Math.min(samples.length - at, this.hop - this.sinceAnalysis);
      this.stream.push(samples.subarray(at, at + take));
      at += take;
      this.sinceAnalysis += take;
      if (this.sinceAnalysis === this.hop) {
        this.sinceAnalysis = 0;
        // The first analysis waits for one full window: a window still half zeros is no reading, and its filling up
        // looked like an attack (unplayed mains hum then counted as "played").
        if (due <= maxPerPush && this.stream.total >= this.warmUp) last = this.analyze();
        due--;
      }
    }
    return last;
  }

  /**
   * One analysis of the newest samples (signal time = end of the stream). After an onset the window starts at the
   * attack until a full window fits (fix round 1): a window that mixes the old vibration with the new one reads
   * neither (re-plucks read −14 cents for 0.15 s). Like the silence trim, such windows count as trimmed (S3).
   */
  analyze(): TunerState {
    const sr = this.stream.sr;
    const t = this.stream.total / sr;
    // An onset deferred in the previous analysis: judge it before choosing the window. A transient puts the window back
    // to the old note's attack; a note keeps the window cut at the new attack (located in the previous analysis).
    const waiting = this.tracker.awaitingAttack;
    const verdict = waiting !== null ? this.attackVerdict(waiting) : undefined;
    if (verdict === 'transient') this.onsetSample = this.prevOnsetSample;
    // The long window only once the stream holds it (a half-empty window ramps its level: mains hum looked unsteady).
    const grown = this.tracker.windowSize(sr, t);
    const full = grown <= this.stream.total ? grown : this.warmUp;
    const since = this.stream.total - this.onsetSample;
    const cut = since < full;
    const w = cut ? Math.max(CUT_MIN, Math.ceil(since / CUT_STEP) * CUT_STEP) : full;
    const win = this.stream.window(Math.min(full, w));
    this.window = win;
    const det = this.detector.detect(win, sr, cut ? { ...this.opts, cut: true } : this.opts);
    // Mains hum measured and heard recently (fix round 2): the window is also analysed with the hum removed (comb at
    // the mains period); the tracker takes that pitch when it is clear (TrackerAux.dehum).
    const mains = this.tracker.humToRemove(t);
    const dehum = mains !== null ? this.residual(mains) : undefined;
    const novelty = this.onset.update(this.stream.window(this.onset.n));
    this.analyses++;
    const state = this.tracker.update(det, t, {
      novelty,
      residual: (hz) => this.residual(hz),
      verifiesAttacks: true,
      attack: verdict,
      dehum,
      lowerPresent: (hz, k) => this.detector.lowerPresent(hz, k),
      noteSounds: (hz, k) => this.detector.noteSounds(hz, k),
      partialDb: (hz) => this.detector.partialDb(hz),
      lowCut: (hz) => this.lowCut(hz),
    });
    if ((state.onset && verdict === undefined) || this.tracker.awaitingAttack !== null) {
      this.prevOnsetSample = this.onsetSample;
      this.onsetSample = this.locateOnset();
    }
    return state;
  }

  /**
   * Fix round 2 — click/transient rejection. An onset while a note sounds is a new note if the level after the attack
   * stays up, or if the vibration changed (a re-pluck replaces it); a metronome click or a tap is a short burst on top
   * of a note that continues phase-coherently. Measured from 25 ms after the attack to now (one analysis later):
   * rise = level against the 50 ms before the attack; coherence = energy of x(i) − x(i − L) relative to x(i), with L a
   * whole number of the old note's periods reaching back before the attack. Thresholds: TRACKER.transient*.
   */
  private attackVerdict(hz: number): 'note' | 'transient' {
    const sr = this.stream.sr;
    const now = this.stream.total;
    const a = this.onsetSample;
    const post0 = a + Math.round(TRACKER.transientPostS * sr);
    const gap = Math.round(0.005 * sr);
    const preLen = Math.round(0.05 * sr);
    const postLen = now - post0;
    if (!(hz > 0) || !Number.isFinite(a) || postLen < gap) return 'note';
    const period = sr / hz;
    const lag = Math.ceil((now - a + gap) / period) * period;
    const n = Math.ceil(Math.max(now - (a - gap - preLen) + lag + 2, postLen + lag + 2));
    if (n > this.stream.capacity) return 'note';
    const x = this.stream.window(n);
    const ia = n - (now - a); // index of the attack in x
    const L = Math.floor(lag);
    const f = lag - L;
    // Energy of x and of x(i) − x(i − lag) (linear interpolation) over [i0, i1).
    const measure = (i0: number, i1: number) => {
      let e = 0;
      let d = 0;
      for (let i = i0; i < i1; i++) {
        const j = i - L;
        const prev = x[j] * (1 - f) + x[j - 1] * f;
        e += x[i] * x[i];
        d += (x[i] - prev) * (x[i] - prev);
      }
      return { e, coh: 10 * Math.log10((d + 1e-20) / (e + 1e-20)) };
    };
    const pre = measure(ia - gap - preLen, ia - gap);
    const post = measure(n - postLen, n);
    const riseDb = 10 * Math.log10((post.e / postLen + 1e-20) / (pre.e / preLen + 1e-20));
    // A soft new string over a loud ringing one (¼ force) rises < 1.5 dB and leaves the old period −5 dB coherent, but
    // its coherence is ≥ 3 dB worse than the old note's own just before the attack (a click's is not), fix round 2.
    const newVibration = post.coh - pre.coh >= TRACKER.transientNewCoherenceDb && post.coh >= TRACKER.transientNewMinDb;
    return riseDb < TRACKER.transientRiseDb && post.coh < TRACKER.transientCoherenceDb && !newVibration ? 'transient' : 'note';
  }

  /**
   * Fix round 3 — the current window with everything below half the shown note removed: two cascaded 2nd-order
   * Butterworth high-passes (24 dB/octave) at fc = hz / 2, run over the window plus the samples before it (at least 4
   * filter time constants of warm-up, so no start-up transient reaches the window, D32). For handling noise and room
   * rumble (30–60 Hz) louder than a ringing string: the Iowa guitar takes read 32–60 Hz from ≈ 1.8 s on while the
   * string still rang (real set 1, 7 of 17 notes "held"). Uses the low-cut detector's own buffers.
   */
  private lowCut(hz: number): Detection | null {
    const x = this.window;
    if (!x || !(hz > 0)) return null;
    const sr = this.stream.sr;
    const fc = hz / 2;
    const warm = Math.max(1024, Math.ceil((8 * sr) / fc));
    const n = x.length + warm;
    if (n > this.stream.capacity || n > this.stream.total) return null;
    const src = this.stream.window(n);
    let y = this.lowCutBuf.get(x.length);
    if (!y) this.lowCutBuf.set(x.length, (y = new Float64Array(x.length)));
    const w0 = (2 * Math.PI * fc) / sr;
    const alpha = Math.sin(w0) / Math.SQRT2;
    const cw = Math.cos(w0);
    const a0 = 1 + alpha;
    const b0 = (1 + cw) / 2 / a0;
    const b1 = -(1 + cw) / a0;
    const a1 = (-2 * cw) / a0;
    const a2 = (1 - alpha) / a0;
    // Two biquads in series (direct form I), states s1 (x1, x2, y1, y2) and s2.
    let p1 = 0, p2 = 0, q1 = 0, q2 = 0, r1 = 0, r2 = 0, u1 = 0, u2 = 0; // prettier-ignore
    for (let i = 0; i < n; i++) {
      const v = src[i];
      const o = b0 * v + b1 * p1 + b0 * p2 - a1 * q1 - a2 * q2;
      p2 = p1;
      p1 = v;
      q2 = q1;
      q1 = o;
      const o2 = b0 * o + b1 * r1 + b0 * r2 - a1 * u1 - a2 * u2;
      r2 = r1;
      r1 = o;
      u2 = u1;
      u1 = o2;
      if (i >= warm) y[i - warm] = o2;
    }
    this.lowCutRuns++;
    return this.lowCutDetector.detect(y, sr, this.opts);
  }

  /** The attack inside the last two hops: the 256-sample block with the largest energy rise over the 3 before it. */
  private locateOnset(): number {
    const n = 2 * this.hop + 4 * ONSET_BLOCK;
    const x = this.stream.window(n);
    const blocks = Math.floor(n / ONSET_BLOCK);
    const e = new Float64Array(blocks);
    for (let b = 0; b < blocks; b++) {
      let s = 0;
      for (let i = b * ONSET_BLOCK; i < (b + 1) * ONSET_BLOCK; i++) s += x[i] * x[i];
      e[b] = s + 1e-20;
    }
    let best = 4;
    let bestRise = -Infinity;
    for (let b = 4; b < blocks; b++) {
      const rise = e[b] / ((e[b - 1] + e[b - 2] + e[b - 3]) / 3);
      if (rise > bestRise) {
        bestRise = rise;
        best = b;
      }
    }
    return this.stream.total - n + best * ONSET_BLOCK;
  }

  /**
   * The current window with a previous note removed (review M2): y[i] = x[i] − x(i + P), P = sr / hz, a feed-forward
   * comb with zeros at every multiple of that note (cubic interpolation for the fractional lag). A new note at another
   * pitch keeps its partials (gain 2·|sin(π·f/hz)|), so the detector reads it cleanly; a re-pluck of the same note,
   * or its octave, is removed too (then the raw detection serves).
   */
  private residual(hz: number): Detection | null {
    const x = this.window;
    if (!x || !(hz > 0)) return null;
    const sr = this.stream.sr;
    const lag = sr / hz;
    const n = Math.floor(lag);
    const f = lag - n;
    const len = x.length - n - 3;
    if (len < x.length / 2) return null; // the old note's period takes more than half the window
    let y = this.comb.get(len);
    if (!y) this.comb.set(len, (y = new Float64Array(len)));
    // 4-point Lagrange interpolation of x at i + n + f (points i+n−1 … i+n+2).
    const c0 = (-f * (f - 1) * (f - 2)) / 6;
    const c1 = ((f + 1) * (f - 1) * (f - 2)) / 2;
    const c2 = (-(f + 1) * f * (f - 2)) / 2;
    const c3 = ((f + 1) * f * (f - 1)) / 6;
    for (let i = 0; i < len; i++) {
      const j = i + n + 1; // x(j + f − 1) with taps j−1 … j+2 = i+n … i+n+3
      y[i] = x[i + 1] - (c0 * x[j - 1] + c1 * x[j] + c2 * x[j + 1] + c3 * x[j + 2]);
    }
    this.residualRuns++;
    return this.residualDetector.detect(y, sr, hz === this.tracker.humToRemove(this.stream.total / sr) ? this.opts : { ...this.opts, octave: false });
  }
}

/** Runs a whole buffer through the engine with one analysis every `hop` samples (default 30 per second). */
export function runOffline(samples: Float32Array, sr: number, config: TrackerConfig, hop = Math.round(sr / ANALYSIS_RATE), opts?: DetectOptions): TunerState[] {
  const engine = new TunerEngine(sr, config, opts, hop);
  const out: TunerState[] = [];
  for (let at = 0; at + hop <= samples.length; at += hop) {
    const s = engine.push(samples.subarray(at, at + hop));
    if (s) out.push(s);
  }
  return out;
}
