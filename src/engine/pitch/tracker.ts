// Tracker (SPEC §5.4): turns detector frames (30 analyses per second of signal time, overlapping windows) into what
// the tuner shows. Times are SIGNAL time in seconds (the window's end), so the same code runs on files, fakes and the
// live stream. Every rule is expressed in seconds, not frames, so the behaviour does not depend on the analysis rate
// (review S1); the engine analyses at a fixed signal-time hop (stream.ts).
import { centsBetween, midiToHz, nearestNote } from '../notes';
import { windowSize as baseWindow, type Detection } from './detect';
import type { OnsetMeasure } from './onset';

export type TunerStatus = 'idle' | 'listening' | 'noisy' | 'flat' | 'sharp' | 'inTune' | 'muchTooHigh' | 'veryLow' | 'harmonic';

export type TrackerConfig = {
  a4: number;
  /** Target notes (MIDI, capo applied, course members included), in any order — normally as played. Empty = chromatic. */
  targets: number[];
  /**
   * For each entry of `targets`, the string (course) number the UI shows for it. Default: the entry's position in
   * `targets`. `locked` and the returned `stringIndex` use this numbering (review S7: re-entrant ukulele, banjo, courses).
   */
  strings?: number[];
  /** String (course) number of a manually locked string, in the numbering of `strings`, or null for auto. */
  locked: number | null;
  /** "In tune" tolerance in cents (1/2/3/5). */
  tolerance: number;
  /** Absolute level (dBFS) above which a pitchless sound counts as "too noisy" (review S11: calibrate per input source in P3). */
  noisyMinDb?: number;
};

export type TunerState = {
  status: TunerStatus;
  /** Smoothed frequency of the reading (what was played — never folded into the instrument's range). */
  hz: number | null;
  /** Nearest note of the reading at A4 (what was played). */
  noteMidi: number | null;
  /** Target the cents refer to: the string (instrument mode) or the nearest note (chromatic). */
  targetMidi: number | null;
  /** String (course) number of the target (instrument mode), as in `TrackerConfig.strings`. */
  stringIndex: number | null;
  /** Smoothed cents of the played pitch against the target (needle). */
  cents: number | null;
  /** Integer cents with ±0.6 hysteresis (the number on screen). */
  displayCents: number | null;
  /**
   * Status 'harmonic': the reading is the 2nd/3rd/4th partial of the target string (12th/7th/5th-fret harmonic, review
   * M4). `harmonicCents` is the deviation from that partial (how the open string would read); no direction is given.
   */
  harmonic: number | null;
  harmonicCents: number | null;
  stable: boolean;
  /**
   * Fix round 3 (L26): instrument auto mode, and the octave of the note is not proven (`Detection.octaveAmbiguous`):
   * no string is chosen yet — target = the nearest note (chromatic), `stringIndex` null. Cents and the note name are
   * the same in either octave; only the octave and the string are unsure.
   */
  octaveUnsure: boolean;
  /** Reading kept greyed after the sound stopped (or while another sound hides it). */
  held: boolean;
  /** The current sound was classified as mains hum and is not shown. */
  hum: boolean;
  /** An onset (new note) was detected in this frame. */
  onset: boolean;
  t: number;
};

/** Optional per-frame inputs from the engine. */
export type TrackerAux = {
  /** Spectral onset measure of the newest ≈ 85 ms (onset.ts). */
  novelty?: OnsetMeasure;
  /**
   * Detection of the same window with a previous note removed (comb filter at its period; stream.ts). The tracker
   * asks for it only while a previous note may still ring under a new one (review M2).
   */
  residual?: (previousHz: number) => Detection | null;
  /**
   * The engine can check an onset one analysis later against the stream (fix round 2): set when it can. An onset while
   * a reading is shown then waits one analysis for `attack`, so a metronome click or a tap on top of a sounding note
   * never resets that note.
   */
  verifiesAttacks?: boolean;
  /**
   * Verdict on the onset deferred in the previous analysis: 'note' (a new pluck / re-pluck: the energy after the attack
   * stays up or the vibration changed) or 'transient' (the note continues phase-coherently at the old level).
   */
  attack?: 'note' | 'transient';
  /** Detection of the same window with mains hum removed (asked for through `Tracker.humToRemove`, fix round 2). */
  dehum?: Detection | null;
  /**
   * Fix round 3: does the analysed window still hold the note `hz` itself (its first partial, or a partial that its
   * k-th partial lacks), i.e. is a reading at k·hz that note's own k-th partial? (`PitchDetector.lowerPresent`)
   */
  lowerPresent?: (hz: number, k: number) => boolean;
  /**
   * Fix round 3: does a note `hz` sound in the analysed window with its own first partial and another partial its
   * k-th partial lacks, both within 30 dB of the strongest line (a real lower note, not a lone tone)?
   * (`PitchDetector.noteSounds`)
   */
  noteSounds?: (hz: number, k: number) => boolean;
  /** Fix round 3: level of the partial at `hz` in the analysed window, dB re the strongest line (−Infinity if unresolved). */
  partialDb?: (hz: number) => number;
  /** Fix round 3: detection of the same window with everything below hz / 2 removed (handling noise, rumble). */
  lowCut?: (hz: number) => Detection | null;
};

/** Start values from SPEC §5.4; changed only by measurements (D32/D33; fix round 1: D36). Times in seconds. */
export const TRACKER = {
  floorWindowS: 3,
  floorPercentile: 0.1,
  /** The floor is (re)computed only from at least this many fresh noise frames; one stray frame never sets it. */
  floorMinFrames: 8,
  /** Frames this soon after an onset never feed the noise floor (the attack window is often "closed", review M1). */
  floorSkipAfterOnsetS: 0.15,
  /** While a reading is shown or held, closed frames within this many dB of the note's level are the note, not noise. */
  floorNoteMarginDb: 10,
  openAboveFloorDb: 9,
  openMinDb: -70,
  openClarity: 0.85,
  keepAboveFloorDb: 6,
  keepMinDb: -72,
  keepClarity: 0.8,
  /** Consistency gate (fix round 2): clarity ≥ 0.6 in a trusted window, ±20 c over 3 analyses, level ≥ floor + 15 dB. */
  consistentClarity: 0.6,
  consistentCents: 20,
  consistentAboveFloorDb: 15,
  onsetRiseDb: 6,
  onsetWindowS: 0.06,
  /** Spectral onset (onset.ts): share of new energy in the newest 85 ms and its level rise (measured in fix round 1). */
  noveltyOnset: 0.3,
  noveltyRiseDb: 1.5,
  onsetRefractoryS: 0.08,
  /**
   * Fix round 3: a spectral (novelty) onset needs this long after the previous onset. Novelty compares the newest 85 ms
   * with the two analyses before; until both of those lie after the previous attack (85 ms + 2 hops ≈ 0.15 s) a note
   * from silence still looks "new" against them, and real plucks and piano notes got a second onset ≈ 0.13 s in that
   * reset the reading (real set 1: 26 of 46 pizzicato/piano recordings ≥ 70 Hz had a second onset within 0.2 s, 5 after
   * this rule). A level rise ≥ 6 dB keeps the 0.08 s.
   */
  noveltyRefractoryS: 0.15,
  /**
   * Transient test (fix round 2, engine `attackVerdict`): an onset over a shown reading is a click/tap, not a note, when
   * the level from 25 ms after the attack is < 1.5 dB above the 50 ms before it AND the old note continues
   * phase-coherently (stream minus itself one whole number of periods earlier ≤ −2.5 dB). Measured on blind set 1
   * (tuning set since fix round 2) + the tuning sequences: clicks over notes rise ≤ 1.3 dB with coherence ≤ −3.0 dB;
   * new notes / re-plucks at equal or double force rise ≥ 1.7 dB, or (a re-pluck at a lower level) +1.2 dB with coherence
   * +2.8 dB (the vibration was replaced).
   */
  transientRiseDb: 1.5,
  transientCoherenceDb: -2.5,
  /**
   * …unless the coherence after the attack is ≥ 3 dB worse than the old note's own before it AND no better than −12 dB:
   * then a softer new string sounds (probe t1c at ¼ and ½ force: +2.7…+14 dB, −6…−4 dB; clicks ≤ +0.5 dB, or at −16 dB
   * and below where the old note is very coherent).
   */
  transientNewCoherenceDb: 3,
  transientNewMinDb: -12,
  transientPostS: 0.025,
  /**
   * While an onset waits for its verdict, and for 0.2 s after a transient (the longest window still holds it), a frame
   * whose estimate leaves the reading by > 50 c or whose gate closes by clarity alone keeps the reading as it was.
   */
  transientShadowS: 0.2,
  /** Nominal mains band; a sound in it that was not played is hum only near the measured mains frequency (S4). */
  humBandHz: 1.0,
  humMatchHz: 0.2,
  humNominalMatchHz: 0.4,
  humFreqs: [50, 60, 100, 120],
  humLearnS: 0.5,
  humSteadyDb: 1,
  /** A sound that began with an onset (an amplifier switched on) is hum only after this long, steady, at the mains. */
  humPlayedS: 4,
  humLockCents: 30,
  /**
   * Fix round 2: once the mains frequency is measured, and hum was heard within the last 10 s, every window is also
   * analysed with the mains hum removed (comb at the mains period, `TrackerAux.dehum`); a clear pitch there is the note
   * under the hum (blind set 1 `hum-under`: hum harmonics inside the first-partial band read E2 +20 c, A2 never opened).
   */
  dehumS: 10,
  /** The dehummed reading serves unless its median movement per analysis exceeds the raw one's by more than this. */
  dehumJitterMarginCents: 0.3,
  octaveTolCents: 40,
  /**
   * Fix round 3 — octave continuity: without an onset a reading never moves by 2×, 3× or 4× (or 1/2–1/4) of the current
   * note (±40 c): the estimate is taken back to the note's octave (a fading fundamental, a sympathetic string or a body
   * tone under a tail, real set 1: viola C3 → "C4 on the D string −210 c", guitar E2 → "D string +156 c", A2 → A0 27 Hz
   * "very low"). Exceptions: the detector found a real lower note (`octaveFix` < 1: corrects an octave error of the first
   * windows; in locked mode only towards the locked string), or — not in locked mode — the note's own partials are gone
   * from the spectrum (an octave slur on a wind instrument, a touched harmonic): then the octave guard decides as before.
   */
  octaveContinuity: true,
  /**
   * …only once the note has had trusted estimates for this long: in its first 0.15 s an octave jump without onset is the
   * attack settling (a flute G6 speaks as C5 for two analyses — the tube's fundamental, real set 1 `219`), and the octave
   * guard decides as before.
   */
  continuityAfterS: 0.15,
  /** A proven lower octave corrects the note only within this long after its first trusted estimate (attack errors). */
  correctWithinS: 0.5,
  /** …and in auto / chromatic mode a lower common period is read as the note while its first partial is this strong (dB re the strongest line). */
  notePresentDb: -30,
  /** Low-cut re-analysis (TrackerAux.lowCut): when the window reads below this share of the shown note, or nothing clear. */
  lowCutBelow: 0.7,
  /** …only for notes from this frequency up (the cut at half the note must stay above the 20 Hz stream high-pass). */
  lowCutMinHz: 80,
  /** Octave guard and large-jump guard (separate timers, M3): a change without onset is ignored this long (3 frames at 30/s). */
  guardS: 0.09,
  jumpCents: 150,
  openTail: 0.1,
  confirmCents: 50,
  confirmMinS: 0.025,
  smoothTauS: 0.06,
  medianS: 0.07,
  hysteresis: 0.6,
  displayStepS: 0.03,
  /**
   * Stable = the estimates of the last 0.067 s (3 at 30/s) within ±3 cents of their mean, all from trusted windows (S3).
   * Fix round 2: was 0.1 s / 4. With the transient check, hum removal and the trusted-only smoothing the shorter span
   * met the accepted settle p95 (200 / 400 ms) on blind set 1 (a tuning set since this round) without raising wrong
   * "in tune" frames (reviewer probe t5: 0 of 543; was 6 of 574 at 0.1 s before this round). Measured trade-off in D37.
   */
  stableS: 0.0667,
  stableMin: 3,
  stableCents: 3,
  /** Stable in noise (fix round 2, `stableInNoise`). */
  noisyStableS: 0.3,
  noisyStableSpanS: 0.2,
  noisyStableMin: 6,
  noisyStableSdCents: 6,
  noisyStableSeCents: 0.75,
  noisyStableTrendCents: 2,
  /** …and the smoothed reading within this of their mean (fix round 2). */
  stableCatchupCents: 2,
  /** …reaching back at most this far over frames without an estimate (fix round 2). */
  stableGapS: 0.3,
  /**
   * A trusted window holds ≥ 16 periods, or was not trimmed and holds ≥ 5 (E1 needs the long window, B0 just fits in
   * it). Measured on the tuning set's first 0.4 s: trimmed with 16+ periods max 1.4 c; < 5 periods p95 28–38 c.
   */
  trustPeriods: 5,
  /**
   * Fewer periods than this, before the note's first trusted estimate: the reading is not shown (fix round 2). Below
   * 5 periods the first-partial band cannot hold the partial's main lobe, and the NSDF period of a stiff string reads
   * +6…+29 c (A1 +15 c, B0 +13 c, D1 harmonic +40 c with the old narrow band).
   */
  roughPeriods: 5,
  trustPeriodsTrimmed: 16,
  switchCents: 50,
  switchS: 0.06,
  ambiguityCents: 100,
  muchTooHighCents: 300,
  veryLowCents: -700,
  harmonicCents: 50,
  holdS: 1.5,
  noisyS: 3,
  noisyAboveFloorDb: 15,
  noisyMinDb: -50,
  lowModeHz: 70,
  growBelowHz: 300,
  /**
   * Fix round 3: an onset this soon after the previous one is part of the same attack (a pizzicato's second rise, a
   * re-tongued oboe note): the reading before it is not a previous note that rings under a new one, so no residual is
   * taken. Real set 1: double-bass pizz A2 read through the comb at its own gliding attack pitch → A1 (`065`, whole
   * note), oboe A♯4 → its 3rd partial F6 (`131`); both second onsets came 0.133 s after the first. Tuning sequences
   * place the next string ≥ 0.4 s later.
   */
  polyMinS: 0.2,
  /** The residual is no longer computed once raw alone has served (agreeing, or the residual unclear) this long. */
  polyAgreeS: 0.3,
  /** A residual at a multiple of the removed note this far below the window's level is a leftover of that note. */
  leftoverDb: 30,
};

type Frame = { t: number; rmsDb: number };
/** Slack for the time windows (stability, median): hops are whole samples, so 4 hops at 44.1 kHz/120 per s ≠ 0.1 s exactly. */
const SLACK_S = 0.005;
type Estimate = { c: number; t: number; trusted: boolean };
type Target = { midi: number; string: number };

const centsOf = (hz: number, a4: number) => 100 * (69 + 12 * Math.log2(hz / a4));
/** Integer ratios 1…8 in cents: sub-harmonics of a note, or partials of a removed note. */
const RATIOS = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => 1200 * Math.log2(k));
/** `hz` is (within ±40 cents) the note `ref` divided by an integer 1…8 (unison included). */
const subRelated = (hz: number, ref: number) => {
  const d = 1200 * Math.log2(ref / hz);
  return RATIOS.some((x) => Math.abs(d - x) <= TRACKER.octaveTolCents);
};
/** `hz` is (within ±40 cents) the note `ref` times an integer 2…8. */
const multiple = (hz: number, ref: number) => {
  const d = 1200 * Math.log2(hz / ref);
  return RATIOS.slice(1).some((x) => Math.abs(d - x) <= TRACKER.octaveTolCents);
};
/**
 * A residual pitch that is the removed note itself or a sub-multiple of it is what is left of that note (vibrato, a
 * slightly wrong period) — a new note below it is read by the raw detection anyway (its period is the common one).
 * A multiple is a new note only if the residual is not faint: leftovers of stretched partials are ≥ 30 dB below the
 * window, a string an octave or two up that is a few cents off the old one's partial is not (E2 ringing, E4 plucked).
 */
const leftover = (r: Detection, raw: Detection, ref: number) =>
  r.hz !== null && (subRelated(r.hz, ref) || (multiple(r.hz, ref) && r.rmsDb < raw.rmsDb - TRACKER.leftoverDb));
/** `hz` is mains hum `h` (or a harmonic of it) or a common period of a note with it (h / 2 … h / 8), ±0.4 Hz per harmonic. */
const humExplains = (hz: number, h: number) => {
  for (let k = 1; k <= 4; k++) if (Math.abs(hz - k * h) <= TRACKER.humNominalMatchHz * k) return true;
  for (let j = 2; j <= 8; j++) if (Math.abs(hz * j - h) <= TRACKER.humNominalMatchHz) return true;
  return false;
};
const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; // fix round 2: of two, the mean (was the lower one)
};

export class Tracker {
  private cfg: TrackerConfig;
  private sorted: Target[] = []; // targets low → high, with their string numbers
  private history: Frame[] = []; // rms of every frame, last 3 s (onset + hum steadiness)
  private closedLevels: Frame[] = []; // rms of frames that were neither notes nor attacks (noise floor)
  private floorHeld = -100; // the floor keeps its last value while no fresh noise frames exist (M1)
  private open = false;
  private lastOnsetT = -Infinity;
  private raw: Estimate[] = []; // accepted raw estimates (absolute cents = 100 × MIDI) of the current note
  private smoothed: number | null = null;
  /** The smoothed value already rests on a trusted estimate (fix round 2). */
  private smoothTrusted = false;
  private lastT: number | null = null;
  private display: number | null = null;
  private displayT = -Infinity;
  private stringIdx: number | null = null; // index into `sorted`
  private switchCandidate: { idx: number; since: number } | null = null;
  private octaveSince: number | null = null;
  private jumpSince: number | null = null;
  private subSince: number | null = null;
  private stableHz: number | null = null;
  private noteStartCents: number | null = null;
  /** The current note segment began at a detected onset (a pluck/bow attack), not by a jump or at stream start. */
  private fromOnset = false;
  private pendingOpen: { c: number; t: number; rough?: boolean } | null = null;
  private lastShown: TunerState | null = null;
  private lastOpenDb = -Infinity;
  private closedSince: number | null = null;
  private clarityClosedSince: number | null = null;
  /** Previous note (Hz) that may still ring under the current one; the residual removes it (M2). */
  private polyRef: number | null = null;
  private polyServedSince: number | null = null;
  /** The note that preceded the current one (kept for the whole segment, unlike polyRef). */
  private segmentPrev: number | null = null;
  private mains: number | null = null; // measured mains fundamental (Hz)
  private lastHumT = -Infinity; // last frame classified as mains hum
  /** Last analysis that saw a pitch below `growBelowHz` with clarity ≥ 0.5, gate open or not (window growth, fix round 2). */
  private lowSeenT: number | null = null;
  /** Recent trusted estimates with clarity ≥ 0.6 (consistency gate, fix round 2). */
  private recentClear: { t: number; c: number }[] = [];
  private mainsReadings: number[] = [];
  /** Analysis-to-analysis movement (EMA, cents) of the raw and the dehummed estimates while both read the note. */
  private jitter: { cr: number; cd: number; dr: number[]; dd: number[] } | null = null;
  /** Onset seen while a reading was shown, waiting one analysis for the engine's transient verdict (fix round 2). */
  private deferredOnset: { t: number; hz: number } | null = null;
  /** Time of the last onset judged a transient (refractory: its rise is still inside the next analyses). */
  private lastTransientT = -Infinity;
  /** Onsets judged transients (cost/diagnostics). */
  transients = 0;
  /** Fix round 3: the current note's octave is not proven yet (auto mode: no string chosen from it). */
  private unsure = false;
  /** Fix round 3: the current note has had a trusted estimate without octave doubt. */
  private octaveProven = false;
  /** Fix round 3: signal time of the current note's first trusted estimate. */
  private firstTrustedT: number | null = null;
  /** Fix round 3: estimates taken back to the note's octave (diagnostics). */
  folds = 0;
  /** Fix round 3: analyses served by the low-cut detection (diagnostics). */
  lowCutServed = 0;

  constructor(config: TrackerConfig) {
    this.cfg = { ...config };
    this.sortTargets();
  }

  /** Tuning, lock, A4 or tolerance changed: the string choice and smoothing restart. */
  setConfig(config: Partial<TrackerConfig>): void {
    const targetsOnly = config.targets !== undefined && config.strings === undefined;
    this.cfg = { ...this.cfg, ...config, ...(targetsOnly ? { strings: undefined } : {}) };
    this.sortTargets();
    this.stringIdx = null;
    this.switchCandidate = null;
    this.deferredOnset = null;
    this.resetNote();
  }

  get config(): TrackerConfig {
    return this.cfg;
  }

  /**
   * Fix round 2 — which detection serves while hum is removed. The comb (dehum) reads plucked notes under hum exactly
   * (hum lines inside the first-partial band pulled E2 +20 c), but a bowed note's amplitude jitter passes through it
   * as pitch noise (cello G2 next to the 100 Hz zero: 8.6 c). So: the dehum when the window as heard has no clear pitch
   * or another one (hum or a common period, > 50 c away); when both read the same note, the dehummed one unless its
   * estimates move more from analysis to analysis (median |Δ cents| of the last 6, + 0.3 c); the raw one until both have
   * a history. A pitch at a multiple of
   * the mains (±1 Hz) in the dehummed window is what is left of the hum itself (its frequency wanders), never a note.
   */
  private dehummed(raw: Detection, dh: Detection | null | undefined): Detection {
    const T = TRACKER;
    if (!dh || dh.hz === null || dh.clarity < T.keepClarity || dh.tail < T.openTail || this.mains === null) {
      this.jitter = null;
      return raw;
    }
    const m = Math.round(dh.hz / this.mains);
    if (m >= 1 && Math.abs(dh.hz - m * this.mains) <= T.humBandHz) return raw;
    const use = { ...dh, rmsDb: raw.rmsDb };
    const rawOk = raw.hz !== null && raw.clarity >= T.keepClarity;
    if (!rawOk || Math.abs(centsOf(raw.hz as number, 440) - centsOf(dh.hz, 440)) > T.confirmCents) {
      this.jitter = null;
      return use;
    }
    const cr = centsOf(raw.hz as number, 440);
    const cd = centsOf(dh.hz, 440);
    const j = this.jitter;
    if (j === null) {
      this.jitter = { cr, cd, dr: [], dd: [] };
      return raw;
    }
    j.dr.push(Math.abs(cr - j.cr));
    j.dd.push(Math.abs(cd - j.cd));
    if (j.dr.length > 6) {
      j.dr.shift();
      j.dd.shift();
    }
    j.cr = cr;
    j.cd = cd;
    // Median movement of the last 6 analyses (one jump at the attack does not decide); ties go to the dehummed one.
    return median(j.dd) <= median(j.dr) + T.dehumJitterMarginCents ? use : raw;
  }

  /** Mains frequency (Hz) the engine should remove from the next window (measured, hum heard recently), or null. */
  humToRemove(t: number): number | null {
    return this.mains !== null && t - this.lastHumT <= TRACKER.dehumS ? this.mains : null;
  }

  /** The reading (Hz) whose continuation the engine must check in this analysis (an onset is deferred), or null. */
  get awaitingAttack(): number | null {
    return this.deferredOnset?.hz ?? null;
  }

  private sortTargets(): void {
    const s = this.cfg.strings;
    this.sorted = this.cfg.targets
      .map((midi, i) => ({ midi, string: s && s[i] !== undefined ? s[i] : i }))
      .sort((a, b) => a.midi - b.midi || a.string - b.string);
  }

  private resetNote(): void {
    this.unsure = false;
    this.octaveProven = false;
    this.firstTrustedT = null;
    this.jitter = null;
    this.smoothTrusted = false;
    this.raw = [];
    this.smoothed = null;
    this.display = null;
    this.octaveSince = null;
    this.jumpSince = null;
    this.subSince = null;
    this.noteStartCents = null;
  }

  /**
   * Window size for the next analysis (D33): every note starts with the short window (≈ 85 ms, fast settle); once it
   * has lasted two short windows, low notes (< 300 Hz, or any note of an instrument reaching below 70 Hz) grow to the
   * long window (≈ 170 ms) for resolution against neighbouring partials and noise.
   */
  windowSize(sr: number, nowT?: number): number {
    const short = baseWindow(sr, false);
    if (nowT === undefined) return short;
    const since = (nowT - this.lastOnsetT) * sr;
    if (since < 2 * short) return short;
    // Fix round 2: growth no longer waits for the gate. A low B under a phone-mic roll-off has clarity 0.65 in the
    // 3-period short window, so the gate never opened and the window never grew (blind set 1 `046`: 0 % shown; 5.9
    // periods in the long window read it at 0.86+). A low-tuned instrument grows after every onset; otherwise a low
    // reading, or a low pitch seen (clarity ≥ 0.5) in the last 0.1 s, makes it grow.
    const lowTarget = this.sorted.length > 0 && midiToHz(this.sorted[0].midi, this.cfg.a4) < TRACKER.lowModeHz;
    const hz = this.open && this.smoothed !== null ? this.cfg.a4 * Math.pow(2, (this.smoothed / 100 - 69) / 12) : null;
    const seenLow = this.lowSeenT !== null && nowT - this.lowSeenT <= 0.1 + SLACK_S;
    return lowTarget || (hz !== null && hz < TRACKER.growBelowHz) || seenLow ? baseWindow(sr, true) : short;
  }

  /**
   * 10th percentile of the noise frames of the last 3 s. With fewer than 8 fresh noise frames the last value is kept
   * (M1): neither ageing out nor a single stray frame (the first, unclear window of a string that already rang when the
   * tuner started) can lift the floor to the note's own level.
   */
  private noiseFloor(t: number): number {
    this.closedLevels = this.closedLevels.filter((x) => t - x.t <= TRACKER.floorWindowS);
    if (this.closedLevels.length < TRACKER.floorMinFrames) return this.floorHeld;
    const s = this.closedLevels.map((x) => x.rmsDb).sort((a, b) => a - b);
    this.floorHeld = s[Math.floor(TRACKER.floorPercentile * (s.length - 1))];
    return this.floorHeld;
  }

  /** Index into `sorted` of the nearest target; nearly equidistant between two strings → the lower one ("loosen"). */
  private nearestTarget(c: number, among?: number[]): number {
    const idx = among ?? this.sorted.map((_, i) => i);
    let best = idx[0];
    for (const i of idx) if (Math.abs(c - this.sorted[i].midi * 100) < Math.abs(c - this.sorted[best].midi * 100)) best = i;
    for (let j = 0; j + 1 < idx.length; j++) {
      const lo = this.sorted[idx[j]].midi * 100;
      const hi = this.sorted[idx[j + 1]].midi * 100;
      if (c > lo && c < hi && Math.abs(c - lo - (hi - c)) < TRACKER.ambiguityCents) return idx[j];
    }
    return best;
  }

  private clearFor(d: Detection | null): boolean {
    return !!d && d.hz !== null && d.clarity >= (this.open ? TRACKER.keepClarity : TRACKER.openClarity);
  }

  /**
   * While a previous note may still ring (polyRef), choose between the raw detection and the residual (previous note
   * removed): raw when both agree or the residual has no clear pitch; the residual when it has one and raw does not
   * agree (raw is then the old note or the common period of both notes, review M2).
   */
  private choose(d: Detection, t: number, aux: TrackerAux): Detection {
    if (this.polyRef === null || !aux.residual) return d;
    const r = aux.residual(this.polyRef);
    const rawOk = this.clearFor(d);
    // The residual must be sustained like any note that opens the gate (D33 `openTail`): with the reading's own note
    // removed, a click inside the window is otherwise the clearest pitch left (blind set 1 `337`: +2619 c).
    const resOk = this.clearFor(r) && (r as Detection).tail >= TRACKER.openTail && !leftover(r as Detection, d, this.polyRef);
    const agree = rawOk && resOk && Math.abs(centsOf(d.hz as number, 440) - centsOf((r as Detection).hz as number, 440)) <= TRACKER.confirmCents;
    if (resOk && !agree) {
      this.polyServedSince = null;
      const res = r as Detection;
      return { ...d, hz: res.hz, clarity: res.clarity, period: res.period, firstPartial: res.firstPartial, repaired: res.repaired, trimmed: res.trimmed, periods: res.periods, tail: res.tail };
    }
    if (rawOk) {
      this.polyServedSince ??= t;
      if (t - this.polyServedSince >= TRACKER.polyAgreeS) this.polyRef = null;
    }
    return d;
  }

  private humBand(hz: number): number | null {
    for (const f of TRACKER.humFreqs) if (Math.abs(hz - f) <= TRACKER.humBandHz) return f;
    return null;
  }

  /** One analysis at signal time `t` (end of the analysed window). */
  update(dIn: Detection, t: number, aux: TrackerAux = {}): TunerState {
    const T = TRACKER;
    const prevOnsetT = this.lastOnsetT;
    // Hum removed (fix round 2): a clear pitch in the dehummed window is what sounds under the hum. Level and onset
    // measures stay those of the window as heard. A note at the mains frequency itself is removed with the hum; then the
    // raw detection serves (and the hum rule decides).
    // A pitch at a multiple of the mains (±1 Hz) is what is left of the hum itself (its frequency wanders), not a note.
    const d0 = this.dehummed(dIn, aux.dehum);
    if (d0.hz !== null && d0.clarity >= 0.5 && d0.hz < T.growBelowHz) this.lowSeenT = t;
    // ---- level history, onset ----
    this.history = this.history.filter((f) => t - f.t <= T.floorWindowS);
    const recent = this.history.filter((f) => t - f.t <= T.onsetWindowS + 1e-9);
    const prevDb = this.history.length > 0 ? this.history[this.history.length - 1].rmsDb : -Infinity;
    const floor = this.noiseFloor(t);
    const rise = recent.length > 0 && d0.rmsDb - Math.min(...recent.map((f) => f.rmsDb)) >= T.onsetRiseDb;
    const nv = aux.novelty;
    const attack = !!nv && nv.novelty >= T.noveltyOnset && nv.riseDb >= T.noveltyRiseDb && d0.rmsDb > Math.max(floor + T.openAboveFloorDb, T.openMinDb);
    const onsetNow = (rise || (attack && t - this.lastOnsetT >= T.noveltyRefractoryS - SLACK_S)) && t - this.lastOnsetT >= T.onsetRefractoryS && t - this.lastTransientT >= T.onsetRefractoryS;
    this.history.push({ t, rmsDb: d0.rmsDb });
    // Fix round 2: an onset while a reading is shown waits one analysis for the engine's verdict. The waiting analysis
    // is processed like any other (the note goes on); 'note' applies the onset now — this analysis' window already starts
    // at the attack, so it can be the first estimate of the new note (no latency lost); 'transient' drops it.
    let onset = false;
    let late = false;
    let before: number | null = null; // the reading shown when a deferred onset was seen
    if (this.deferredOnset !== null) {
      const at = this.deferredOnset.t;
      before = this.deferredOnset.hz;
      this.deferredOnset = null;
      if (aux.attack === 'transient') {
        this.lastTransientT = at;
        this.transients++;
      } else {
        onset = true;
        late = true;
        this.lastOnsetT = at;
      }
    } else if (onsetNow) {
      if (aux.verifiesAttacks && this.lastShown !== null && this.lastShown.hz !== null) this.deferredOnset = { t, hz: this.lastShown.hz };
      else onset = true;
    }
    if (onset) {
      // The reading shown (or held) just before may still ring under the new note: remove it from the next windows.
      // A deferred onset takes the reading from before the attack (the waiting analysis may already show the new note).
      this.polyRef = late ? before : this.lastShown && this.lastShown.hz !== null ? this.lastShown.hz : null;
      if ((late ? this.lastOnsetT : t) - prevOnsetT < T.polyMinS) this.polyRef = null;
      this.segmentPrev = this.polyRef;
      this.polyServedSince = null;
      if (!late) this.lastOnsetT = t;
      this.resetNote();
      this.fromOnset = true;
      this.stringIdx = null; // a new note re-chooses its string freely
      this.switchCandidate = null;
      this.open = false; // and re-confirms like a note from silence (the attack window may still be the old note)
      this.pendingOpen = null;
    }
    let d = this.choose(d0, t, aux);
    // Fix round 3 — low-frequency noise louder than a sounding note (handling noise, rumble): while a reading is shown or
    // held and the window as heard loses it (unclear, or a pitch well below it), the window is analysed again with
    // everything below half the note removed; that detection serves when it still reads the note (±50 c).
    if (!onset && aux.lowCut && this.smoothed !== null && this.lastShown !== null && this.lastShown.cents !== null) {
      const noteHz = this.cfg.a4 * Math.pow(2, (this.smoothed / 100 - 69) / 12);
      const recent = this.open || (this.closedSince !== null && t - this.closedSince < T.holdS);
      // An octave, a 12th or two octaves below is the octave rules' question (the note may be that lower one, or a soft new
      // string whose onset was missed: E2 under a ringing E4), never cut away.
      const octaveBelow = d.hz !== null && [1200, 1902, 2400].some((x) => Math.abs(1200 * Math.log2(noteHz / (d.hz as number)) - x) <= T.octaveTolCents);
      const lost = d.hz === null || d.clarity < T.keepClarity || (d.hz < T.lowCutBelow * noteHz && !octaveBelow);
      if (recent && lost && noteHz >= T.lowCutMinHz) {
        const f = aux.lowCut(noteHz);
        if (f && f.hz !== null && f.clarity >= T.keepClarity && f.tail >= T.openTail && Math.abs(centsOf(f.hz, this.cfg.a4) - this.smoothed) <= T.confirmCents) {
          d = { ...f, rmsDb: d.rmsDb };
          this.lowCutServed++;
        }
      }
    }

    // ---- gate ----
    // Fix round 2 — a stiff low string has a low NSDF clarity even when its pitch is plain: a low B with B = 1.5e-3 under
    // a phone-mic roll-off reads 30.87 Hz (−0.04 c) at clarity 0.65 in every long window (blind set 1 `046`: 0 % shown).
    // So a trusted window (≥ 5 periods, not trimmed) with clarity ≥ 0.6 also counts as clear when it agrees within
    // ±20 c with the two analyses before it (also ≥ 0.6) and the level is ≥ 15 dB above the noise floor. Noise has no
    // pitch that repeats like that; mains hum does, and the hum rule decides about it.
    const lowClear = d.hz !== null && d.clarity >= T.consistentClarity && !d.trimmed && d.periods >= T.trustPeriods;
    const cNow = d.hz !== null ? centsOf(d.hz, 440) : null;
    this.recentClear = this.recentClear.filter((x) => t - x.t <= 0.1 + SLACK_S);
    const consistent = lowClear && this.recentClear.length >= 2 && this.recentClear.every((x) => Math.abs(x.c - (cNow as number)) <= T.consistentCents) && d.rmsDb > floor + T.consistentAboveFloorDb;
    if (lowClear) this.recentClear.push({ t, c: cNow as number });
    else this.recentClear = [];
    const clarityOk = d.hz !== null && (d.clarity >= (this.open ? T.keepClarity : T.openClarity) || consistent);
    const levelOk = d.rmsDb > Math.max(floor + (this.open ? T.keepAboveFloorDb : T.openAboveFloorDb), this.open ? T.keepMinDb : T.openMinDb);
    const wasOpen = this.open;
    this.open = clarityOk && levelOk;
    // A click inside the window (onset waiting for its verdict, or judged a transient within the last 0.2 s) may lower
    // the clarity or pull the estimate to its own pitch or to a common period: the reading stays as it was (fix round 2).
    // Also the frame just before such an onset is flagged: the attack sits in the newest eighth of the window (tail ≥ 0.9)
    // and the level rose ≥ 1 dB — a click or a new pluck; the next analyses decide which.
    const attackAtEnd = d.tail >= 0.9 && d0.rmsDb >= prevDb + 1;
    const shadow = this.deferredOnset !== null || t - this.lastTransientT <= T.transientShadowS || attackAtEnd;
    // Fix round 3: in such a frame the first partial alone serves (the partial 1…8 fit took a wood click's energy in the
    // weak upper partials: +17 c on a decaying E4, blind set 1 `341`).
    if (shadow && d.hz1 !== undefined && d.hz !== null) d = { ...d, hz: d.hz1 };
    if (shadow && wasOpen && this.smoothed !== null && this.lastShown !== null && !this.lastShown.held) {
      const off = d.hz !== null && Math.abs(centsOf(d.hz, this.cfg.a4) - this.smoothed) > T.confirmCents;
      // The analysis that waits for a verdict always keeps the reading: its window mixes the old vibration with the
      // attack (a re-pluck read up to 2 c off in it).
      if ((!this.open && levelOk) || (this.open && (off || this.deferredOnset !== null))) {
        this.open = true;
        this.lastT = t;
        return this.emit({ ...this.lastShown, t, held: false, hum: false }, false);
      }
    }
    // Opening needs sustained energy (a click has died away inside the window) and one confirming estimate within 50
    // cents at least 25 ms later (D33): isolated clicks and taps never open the gate; a real note costs one frame.
    if (this.open && !wasOpen) {
      const cand = d.hz !== null ? centsOf(d.hz, this.cfg.a4) : null;
      const sustained = d.tail >= T.openTail;
      const p = this.pendingOpen;
      const confirmed = cand !== null && p !== null && t - p.t >= T.confirmMinS && Math.abs(cand - p.c) <= T.confirmCents;
      if (sustained && confirmed) {
        // The confirming pair = two estimates (a rough one, < 5 periods, is not shown: fix round 2).
        if (this.raw.length === 0 && !p.rough) this.raw.push({ c: p.c, t: p.t, trusted: false });
        this.pendingOpen = null;
      } else {
        this.open = false;
        // After a re-pluck (a reading was shown) the onset frame's own window still holds the old vibration: it never
        // becomes the pending estimate. From silence it may.
        if (!(onset && !late && this.segmentPrev !== null) && !(p !== null && t - p.t < T.confirmMinS)) this.pendingOpen = sustained && cand !== null ? { c: cand, t, rough: d.periods < T.roughPeriods } : null;
      }
    } else if (!(clarityOk && levelOk)) this.pendingOpen = null;
    if (this.open) this.lastOpenDb = d.rmsDb;
    // The floor learns only from noise: not from note candidates, not from the attack just after an onset, and not
    // from a shown/held note that merely lost its clarity (M1: one closed attack frame used to become the floor).
    const noteNear = this.lastShown !== null && d.rmsDb > this.lastOpenDb - T.floorNoteMarginDb;
    if (!(clarityOk && levelOk) && t - this.lastOnsetT > T.floorSkipAfterOnsetS && !noteNear) this.closedLevels.push({ t, rmsDb: d.rmsDb });
    // "Too noisy": sound without a clear pitch. Relative to the floor (SPEC) OR above an absolute level (D33, S11).
    const loud = d.rmsDb > (this.cfg.noisyMinDb ?? T.noisyMinDb) || d.rmsDb > floor + T.noisyAboveFloorDb;
    if (!this.open && loud && !clarityOk) this.clarityClosedSince ??= t;
    else if (this.open || !loud) this.clarityClosedSince = null;

    // ---- candidate in absolute cents (never folded: what was played, review M4) ----
    let c: number | null = null;
    if (this.open && d.hz !== null) {
      c = centsOf(d.hz, this.cfg.a4);
      // Hum (S4): a sound in the mains band is hum only if it was not played (no onset in this segment) and sits at
      // the measured mains frequency (± 0.2 Hz; ± 0.4 Hz of nominal until measured). A locked target is always shown.
      if (this.isHum(d.hz, c, t, !d.trimmed && d.periods >= T.trustPeriods)) {
        this.lastT = t;
        this.humFrame(c, t);
        return this.emit(this.quietState(t, true), onset);
      }
      // Fix round 3 — octave continuity (TRACKER.octaveContinuity).
      let corrected = false;
      // Not while the previous note (the string that rang before this onset) is involved: the reading may still be that
      // string at the attack, or the raw window may read it again under the new one — the residual and the sub-harmonic
      // rule decide there (a new string at 3× or 4× of a ringing one: E2 → B3, E2 → E4).
      const prev = this.segmentPrev !== null ? centsOf(this.segmentPrev, this.cfg.a4) : null;
      const nearPrev = (x: number) => prev !== null && Math.abs(x - prev) <= T.confirmCents;
      const settledNote = this.firstTrustedT !== null && t - this.firstTrustedT >= T.continuityAfterS - SLACK_S;
      if (T.octaveContinuity && !onset && this.smoothed !== null && this.smoothTrusted && !nearPrev(this.smoothed) && !nearPrev(c)) {
        const rel = c - this.smoothed;
        const noteHz = this.cfg.a4 * Math.pow(2, (this.smoothed / 100 - 69) / 12);
        const lockedC = this.lockedCents(this.smoothed);
        for (const k of [2, 3, 4]) {
          const iv = 1200 * Math.log2(k);
          if (Math.abs(rel - iv) <= T.octaveTolCents) {
            // The k-th partial of the note: back to the note once the note is settled (locked, or its own partials still
            // sound), at any age when the detection itself finds the lower octave supported (octaveAmbiguous).
            if ((settledNote && (this.cfg.locked !== null || (aux.lowerPresent?.(noteHz, k) ?? true))) || d.octaveAmbiguous) {
              c -= iv;
              this.folds++;
            }
            break;
          }
          if (Math.abs(rel + iv) <= T.octaveTolCents) {
            // A lower note the detector proved (octaveFix < 1: its own partials sound and the window is clearly more
            // periodic there) corrects an octave error of the first windows (a 4096 window cannot see G1 next to G2) —
            // in locked mode only towards the locked string. Auto / chromatic, and the note's own octave was never
            // proven (its estimates were octave-ambiguous: a guitar A♯2 attack read A♯3 from its strong 2nd partial,
            // real set 1 `009`): the lower note with its own partials is the note. Either applies at once (positive
            // evidence, no guard). Otherwise a settled note in locked mode takes the reading back; auto / chromatic
            // leave it to the sub-harmonic rule below as before (two strings read their common period: the residual
            // shows the new one, else the reading is greyed).
            const proven = (d.octaveFix ?? 1) < 1 && (lockedC === null || Math.abs(c - lockedC) < Math.abs(this.smoothed - lockedC));
            const doubted = lockedC === null && this.unsure && (aux.noteSounds?.(this.cfg.a4 * Math.pow(2, (c / 100 - 69) / 12), k) ?? false);
            // Only while the note is young (its first 0.5 s of trusted estimates): later an octave change without an
            // onset is a tail or a sympathetic string (cello G string under a D4 harmonic, real set 1 `119`/`120`).
            const young = this.firstTrustedT !== null && t - this.firstTrustedT <= T.correctWithinS + SLACK_S;
            if ((proven || doubted) && young) {
              corrected = true;
              this.resetNote();
              this.stringIdx = null;
              this.switchCandidate = null;
            } else if (lockedC !== null && settledNote) {
              c += iv;
              this.folds++;
            }
            break;
          }
        }
      }
      // The raw reading left the current note without an onset: first ask whether a sound that was already there
      // disturbs it — the note that preceded this one, or mains hum — i.e. whether the residual with that sound removed
      // still shows the current note. Then nothing changed (two strings or note + hum read their common period).
      // Fix round 3: mains hum is asked about only when the reading could be hum or its common period with the note
      // (within ±0.4 Hz per harmonic of a mains line or of a sub-multiple of it): a G1 at 49.1 Hz next to "50 Hz" was
      // combed with the hum's period and its own 2nd partial kept the octave error of the attack (real set 1 `164`).
      if (!onset && !corrected && this.polyRef === null && this.smoothed !== null && Math.abs(c - this.smoothed) > T.confirmCents && aux.residual) {
        const hzNow = d.hz;
        const humRefs = (this.mains !== null ? [this.mains] : [50, 60]).filter((h) => humExplains(hzNow, h));
        const refs = [this.segmentPrev, ...humRefs];
        for (const ref of refs) {
          if (ref === null) continue;
          const r = aux.residual(ref);
          if (r && r.hz !== null && this.clearFor(r) && Math.abs(centsOf(r.hz, this.cfg.a4) - this.smoothed) <= T.confirmCents) {
            this.polyRef = ref;
            this.polyServedSince = null;
            c = centsOf(r.hz, this.cfg.a4);
            break;
          }
        }
      }
      // Sub-harmonic without an attack (D33): a pitch at 1/2 … 1/8 of the current note appearing without an
      // onset is the common period of the ringing note and another sound (two strings, note + hum). The residual
      // (current note removed) shows what else sounds; until it has a clear pitch the old reading stays greyed, for
      // at most the hold time (M2: this used to last until the next onset).
      if (!onset && !corrected && this.noteStartCents !== null && this.smoothed !== null) {
        const below = this.noteStartCents - c;
        if (RATIOS.slice(1).some((x) => Math.abs(below - x) <= T.octaveTolCents)) {
          this.subSince ??= t;
          const ref = this.cfg.a4 * Math.pow(2, (this.smoothed / 100 - 69) / 12);
          const r = aux.residual ? aux.residual(ref) : null;
          const rc = r && r.hz !== null && this.clearFor(r) ? centsOf(r.hz, this.cfg.a4) : null;
          // Fix round 3: the residual's note must also explain the window as heard (the raw pitch is its common period
          // with the ringing note, i.e. a sub-multiple of it); rumble left in the residual of a cello D♯4 tail read
          // "G1 48.8 Hz, flat" while the raw window read D♯3 (real set 1 `121`).
          const sm = this.smoothed;
          const xs = RATIOS.slice(1).find((x) => Math.abs(sm - (c as number) - x) <= T.octaveTolCents);
          const lowHz = d.hz as number;
          if (rc !== null && this.humBand((r as Detection).hz as number) === null && !leftover(r as Detection, d, ref) && subRelated(lowHz, (r as Detection).hz as number)) {
            // Another note sounds: a new segment (not played here), read through the residual from now on.
            this.polyRef = ref;
            this.segmentPrev = ref;
            this.polyServedSince = null;
            this.resetNote();
            this.fromOnset = false;
            this.stringIdx = null;
            c = rc;
          } else if (T.octaveContinuity && this.firstTrustedT !== null && t - this.firstTrustedT >= T.continuityAfterS - SLACK_S && xs !== undefined && (aux.partialDb?.(ref) ?? -Infinity) >= T.notePresentDb && !(aux.noteSounds?.(lowHz, Math.round(Math.pow(2, xs / 1200))) ?? true)) {
            // Fix round 3: the note itself still sounds (its first partial within 30 dB of the strongest line) and the
            // window reads its common period with a lone low tone (a sympathetic string, the body: only its first
            // partial, none of its own upper partials): the reading continues in the note's octave instead of going grey.
            // A lower note with its own partials (a soft new string whose onset was missed) stays greyed as before.
            c += xs;
            this.folds++;
            this.subSince = null;
          } else {
            this.lastT = t;
            if (t - this.subSince < T.holdS && this.lastShown && this.lastShown.cents !== null) {
              return this.emit({ ...this.lastShown, held: true, onset, t, hum: false }, onset, false);
            }
            return this.emit(this.quietState(t, false, true), onset);
          }
        } else this.subSince = null;
      }
      // Octave guard: after a stable reading, an octave/12th jump without an onset is ignored for 0.09 s.
      if (c !== null && this.stableHz !== null && !onset && this.smoothed !== null) {
        const jump = Math.abs(c - this.smoothed);
        if ([1200, 1902, 2400].some((x) => Math.abs(jump - x) <= T.octaveTolCents)) {
          this.octaveSince ??= t;
          if (t - this.octaveSince < T.guardS) c = null; // keep showing the previous reading
          else {
            this.resetNote(); // the note really changed
            this.fromOnset = false;
            this.stringIdx = null;
          }
        } else this.octaveSince = null;
      }
      // Any other large jump without an onset (another source took over): ignored for 0.09 s — its own timer (M3) —
      // then a new segment that does not count as played and re-chooses its string.
      if (c !== null && !onset && this.smoothed !== null && Math.abs(c - this.smoothed) > T.jumpCents) {
        this.jumpSince ??= t;
        if (t - this.jumpSince < T.guardS) c = null;
        else {
          this.resetNote();
          this.fromOnset = false;
          this.stringIdx = null;
          if (this.isHum(this.cfg.a4 * Math.pow(2, (c / 100 - 69) / 12), c, t)) {
            this.lastT = t;
            this.humFrame(c, t);
            return this.emit(this.quietState(t, true), onset);
          }
        }
      } else if (c !== null) this.jumpSince = null;
    }

    // Fix round 2: a window holding < 5 periods (a bass string in the short window) reads up to +29 c off on a stiff
    // string; until the note has a trusted estimate, such a reading is not shown (the long window follows 0.17 s after
    // the onset). Costs notes below ≈ 59 Hz ≈ 0.1 s to the first reading, never the settle time (those windows never
    // counted for it).
    if (c !== null && !this.smoothTrusted && (d.periods ?? Infinity) < T.roughPeriods && !(d.periods >= (d.trimmed ? T.trustPeriodsTrimmed : T.trustPeriods))) {
      if (this.smoothed === null) c = null;
    }
    if (c !== null) {
      const periods = d.periods ?? Infinity;
      const trusted = periods >= (d.trimmed ? T.trustPeriodsTrimmed : T.trustPeriods);
      // Fix round 3 (L26): an estimate whose lower octave has some support keeps the string choice open until a
      // trusted estimate without that doubt arrives.
      if (d.octaveAmbiguous) {
        if (!this.octaveProven) this.unsure = true;
      } else if (trusted) {
        this.unsure = false;
        this.octaveProven = true;
      }
      this.raw.push({ c, t, trusted });
      this.raw = this.raw.filter((e) => t - e.t <= 0.5);
      this.noteStartCents ??= c;
      // Fix round 2: once trusted estimates exist, the median uses only them, and the first one replaces the smoothed
      // value outright. Rough first windows (a bass string in < 5 periods reads up to +12 c) used to slide out over
      // 0.2 s through the median and the EMA — inside the steady part of the note (display steps of 3–5 c, A5).
      const recentRaw = this.raw.filter((e) => t - e.t <= T.medianS + SLACK_S);
      const pool = recentRaw.some((e) => e.trusted) ? recentRaw.filter((e) => e.trusted) : recentRaw;
      const med = median(pool.map((e) => e.c));
      const firstTrusted = trusted && !this.smoothTrusted;
      if (trusted) this.smoothTrusted = true;
      if (trusted) this.firstTrustedT ??= t;
      if (this.smoothed === null || this.lastT === null || firstTrusted) this.smoothed = med;
      else {
        const alpha = 1 - Math.exp(-Math.max(0, t - this.lastT) / T.smoothTauS);
        this.smoothed += alpha * (med - this.smoothed);
      }
    }
    this.lastT = t;

    if (this.open && this.smoothed !== null) {
      this.closedSince = null;
      return this.emit(this.reading(t), onset);
    }
    // ---- gate closed: hold, then idle / listening / noisy ----
    if (wasOpen || this.closedSince === null) this.closedSince ??= t;
    if (this.lastShown && this.lastShown.cents !== null && t - (this.closedSince ?? t) < T.holdS) {
      return this.emit({ ...this.lastShown, held: true, onset, t, hum: false }, onset, false);
    }
    this.polyRef = null;
    return this.emit(this.quietState(t, false, levelOk || this.clarityClosedSince !== null), onset);
  }

  /**
   * Mains hum (S4): a sound in the ±1 Hz band of 50/60/100/120 Hz that sits at the measured mains frequency (± 0.2 Hz;
   * ± 0.4 Hz of nominal until measured) and was not played (no onset in this segment). A sound that began with an
   * onset counts as hum only after 4 s at the mains (± 0.2 Hz) with < 1 dB level change over the last 2 s (an
   * amplifier switched on); a played note is never hidden before that. A locked target is always shown.
   */
  private isHum(hz: number, c: number, t: number, trusted = true): boolean {
    const T = TRACKER;
    const band = this.humBand(hz);
    if (band === null) return false;
    if (this.cfg.locked !== null && this.sorted.some((s) => s.string === this.cfg.locked && Math.abs(c - s.midi * 100) <= T.humLockCents)) return false;
    const k = band >= 100 ? 2 : 1;
    const mains = this.mains !== null && Math.abs(this.mains - band / k) < T.humBandHz ? this.mains : null;
    const at = mains !== null ? k * mains : band;
    let hum: boolean;
    // A window of < 5 periods reads hum up to ±0.3 Hz off (fix round 2): it gets the nominal tolerance.
    if (!this.fromOnset) hum = Math.abs(hz - at) <= (mains !== null && trusted ? T.humMatchHz : T.humNominalMatchHz);
    else {
      const levels = this.history.filter((f) => t - f.t <= 2).map((f) => f.rmsDb);
      hum = t - this.lastOnsetT >= T.humPlayedS && Math.abs(hz - at) <= T.humMatchHz && Math.max(...levels) - Math.min(...levels) < T.humSteadyDb;
    }
    if (hum) {
      this.learnMains(hz / k, t);
      this.lastHumT = t;
    }
    return hum;
  }

  /**
   * A frame classified as hum ends the note state and closes the gate (fix round 2): a note that sounds next must
   * confirm like one from silence, and never inherits the hum's smoothing (the next estimate read "−2391 c"). The hum
   * stays the pending estimate, so the next hum frame confirms (and is recognised) again.
   */
  private humFrame(c: number, t: number): void {
    this.open = false;
    this.pendingOpen = { c, t };
    this.resetNote();
  }

  /** Mains frequency from steady, unplayed hum-band sounds (level within 1 dB over 0.5 s). */
  private learnMains(base: number, t: number): void {
    const levels = this.history.filter((f) => t - f.t <= TRACKER.humLearnS).map((f) => f.rmsDb);
    if (levels.length < 3 || Math.max(...levels) - Math.min(...levels) >= TRACKER.humSteadyDb) return;
    // Median of the last 9 readings (fix round 2): the first one used to set the value, and a 4-period window read 50 Hz
    // hum as 49.77 Hz — then hum 0.2 Hz away from that was no longer recognised and the comb removed the wrong lines.
    if (this.mains !== null && Math.abs(this.mains - base) > TRACKER.humBandHz) this.mainsReadings = [];
    this.mainsReadings.push(base);
    if (this.mainsReadings.length > 9) this.mainsReadings.shift();
    this.mains = median(this.mainsReadings);
  }

  /** Cents (×100 MIDI) of the locked string's target nearest to `c`, or null in auto/chromatic mode. */
  private lockedCents(c: number): number | null {
    if (this.cfg.locked === null || this.sorted.length === 0) return null;
    const members = this.sorted.map((s, i) => (s.string === this.cfg.locked ? i : -1)).filter((i) => i >= 0);
    return this.sorted[members.length > 0 ? this.nearestTarget(c, members) : this.nearestTarget(c)].midi * 100;
  }

  private quietState(t: number, hum: boolean, levelOk = false): TunerState {
    let status: TunerStatus = 'idle';
    if (hum) status = 'listening';
    else if (this.clarityClosedSince !== null && t - this.clarityClosedSince > TRACKER.noisyS) status = 'noisy';
    else if (levelOk) status = 'listening';
    return { status, hz: null, noteMidi: null, targetMidi: null, stringIndex: null, cents: null, displayCents: null, harmonic: null, harmonicCents: null, stable: false, octaveUnsure: false, held: false, hum, onset: false, t };
  }

  /** Auto mode: the string of the current note (index into `sorted`). */
  private chooseString(c: number, t: number): number {
    const T = TRACKER;
    const nearest = this.nearestTarget(c);
    if (this.stringIdx === null) {
      this.stringIdx = nearest;
      return nearest;
    }
    if (nearest !== this.stringIdx) {
      // Never switch to a HIGHER string without an onset (S6): tightening a ringing string past the midpoint would
      // otherwise turn "much too high" into "tighten" on the next string. A lower string: after 0.06 s ≥ 50 cents nearer.
      const higher = this.sorted[nearest].midi > this.sorted[this.stringIdx].midi;
      const gain = Math.abs(c - this.sorted[this.stringIdx].midi * 100) - Math.abs(c - this.sorted[nearest].midi * 100);
      if (!higher && gain >= T.switchCents) {
        if (this.switchCandidate?.idx !== nearest) this.switchCandidate = { idx: nearest, since: t };
        if (t - this.switchCandidate.since >= T.switchS - 1e-6) {
          this.stringIdx = nearest;
          this.switchCandidate = null;
        }
      } else this.switchCandidate = null;
    } else this.switchCandidate = null;
    return this.stringIdx;
  }

  /**
   * Fix round 2 — "stable" in noise. At 10 dB SNR the estimates scatter ±3–5 c around the true pitch, so four of them
   * rarely fall within ±3 c of each other and "in tune" flickered (blind set 1 `snr10`: status 79 %). Here the mean of
   * the trusted estimates of the last 0.3 s (≥ 6, spanning ≥ 0.2 s) must be known to ±0.75 c (standard error), without a
   * trend (halves within 2 c), with a spread below 6 c, and the smoothed reading within 1 c of it.
   */
  private stableInNoise(t: number, c: number): boolean {
    const T = TRACKER;
    const xs = this.raw.filter((e) => t - e.t <= T.noisyStableS + SLACK_S);
    if (xs.length < T.noisyStableMin || !xs.every((e) => e.trusted) || xs[xs.length - 1].t - xs[0].t < T.noisyStableSpanS - SLACK_S) return false;
    const n = xs.length;
    const mean = xs.reduce((a, e) => a + e.c, 0) / n;
    const sd = Math.sqrt(xs.reduce((a, e) => a + (e.c - mean) * (e.c - mean), 0) / (n - 1));
    const h = n >> 1;
    const m1 = xs.slice(0, h).reduce((a, e) => a + e.c, 0) / h;
    const m2 = xs.slice(n - h).reduce((a, e) => a + e.c, 0) / h;
    return sd <= T.noisyStableSdCents && sd / Math.sqrt(n) <= T.noisyStableSeCents && Math.abs(m1 - m2) <= T.noisyStableTrendCents && Math.abs(c - mean) <= T.stableCatchupCents;
  }

  private reading(t: number): TunerState {
    const T = TRACKER;
    const c = this.smoothed as number;
    const hz = this.cfg.a4 * Math.pow(2, (c / 100 - 69) / 12);
    const note = nearestNote(hz, this.cfg.a4).midi;
    let target: number;
    let idx: number | null = null; // index into `sorted`
    const unsure = this.sorted.length > 0 && this.cfg.locked === null && this.unsure;
    if (unsure) {
      this.stringIdx = null; // re-chosen once the octave is proven
      this.switchCandidate = null;
    }
    if (this.sorted.length === 0 || unsure) target = note;
    else {
      if (this.cfg.locked !== null) {
        const members = this.sorted.map((s, i) => (s.string === this.cfg.locked ? i : -1)).filter((i) => i >= 0);
        idx = members.length > 0 ? this.nearestTarget(c, members) : this.nearestTarget(c);
      } else idx = this.chooseString(c, t);
      target = this.sorted[idx].midi;
    }
    const cents = c - target * 100;
    // Integer display: ±0.6 hysteresis; small changes move by at most 1 per 1/30 s (no flicker on steady tones, A5),
    // larger ones (turning a peg, a new note) jump directly.
    if (this.display === null) {
      this.display = Math.round(cents);
      this.displayT = t;
    } else if (Math.abs(cents - this.display) > T.hysteresis) {
      const step = Math.round(cents) - this.display;
      if (Math.abs(step) > 2) {
        this.display = Math.round(cents);
        this.displayT = t;
      } else if (t - this.displayT >= T.displayStepS - 1e-6) {
        this.display += Math.sign(step);
        this.displayT = t;
      }
    }
    // Stable: the newest estimates spanning 0.067 s agree within ±3 cents and all come from trusted windows (S3). Frames
    // that kept the reading without an estimate (a click inside the window, fix round 2) are skipped: the estimates may
    // reach back up to 0.3 s, so a click does not cost the "in tune" for the next analyses.
    let from = this.raw.length;
    while (from > 0 && t - this.raw[from - 1].t <= T.stableGapS && (this.raw.length - from < T.stableMin || this.raw[this.raw.length - 1].t - this.raw[from].t < T.stableS - SLACK_S)) from--;
    const last = this.raw.slice(from);
    const span = last.length > 0 ? last[last.length - 1].t - last[0].t : 0;
    const mean = last.reduce((a, b) => a + b.c, 0) / Math.max(1, last.length);
    // …and the smoothed reading is within 2 c of them (fix round 2: a rough first estimate −26 c off left the needle
    // 5 c behind four agreeing estimates, which read "in tune" on a note 7 c sharp).
    const steady =
      last.length >= T.stableMin && span >= T.stableS - SLACK_S && last.every((x) => x.trusted && Math.abs(x.c - mean) <= T.stableCents) && Math.abs(c - mean) <= T.stableCatchupCents;
    const stable = steady || this.stableInNoise(t, c);
    if (stable) this.stableHz = hz;
    let harmonic: number | null = null;
    let harmonicCents: number | null = null;
    const stringNo = idx === null ? null : this.sorted[idx].string;
    if (idx !== null && cents > T.muchTooHighCents) {
      // 12th/7th/5th-fret harmonic of the target string (locked, or the string chosen for this note in auto mode):
      // no direction, never "tighten". Only the chosen string — a string tightened far too high stays "much too high".
      for (const k of [2, 3, 4]) {
        const dev = cents - 1200 * Math.log2(k);
        if (Math.abs(dev) <= T.harmonicCents) {
          harmonic = k;
          harmonicCents = dev;
          break;
        }
      }
    }
    let status: TunerStatus;
    if (harmonic !== null) status = 'harmonic';
    else if (cents > T.muchTooHighCents) status = 'muchTooHigh';
    else if (cents < T.veryLowCents) status = 'veryLow';
    else if (stable && Math.abs(this.display) <= this.cfg.tolerance) status = 'inTune';
    else status = cents < 0 ? 'flat' : 'sharp';
    return { status, hz, noteMidi: note, targetMidi: target, stringIndex: stringNo, cents, displayCents: this.display, harmonic, harmonicCents, stable, octaveUnsure: unsure, held: false, hum: false, onset: false, t };
  }

  private emit(s: TunerState, onset: boolean, remember = true): TunerState {
    const out = { ...s, onset };
    if (remember && out.cents !== null) this.lastShown = out;
    if (!out.held && out.cents === null && out.status === 'idle') this.lastShown = null;
    return out;
  }
}

/** Cents of a reading against a target note (helper for tests and UI). */
export function centsToTarget(hz: number, targetMidi: number, a4: number): number {
  return centsBetween(hz, midiToHz(targetMidi, a4));
}
