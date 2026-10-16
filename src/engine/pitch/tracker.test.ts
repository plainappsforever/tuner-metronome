import { midiToHz } from '../notes';
import type { Detection } from './detect';
import { Tracker, TRACKER, type TrackerConfig, type TunerState } from './tracker';

const HOP = 1 / 30;
const det = (hz: number | null, o: Partial<Detection> = {}): Detection => ({
  hz,
  clarity: 0.97,
  rmsDb: -20,
  period: hz ? 48000 / hz : 0,
  repaired: false,
  firstPartial: true,
  tail: 0.9,
  trimmed: false,
  periods: 40,
  weakFundamental: false,
  ...o,
});
const quiet = (o: Partial<Detection> = {}) => det(null, { clarity: 0.1, rmsDb: -80, ...o });

/** Feeds frames at 30/s; returns every state. */
function feed(tr: Tracker, frames: Detection[], t0 = 0): TunerState[] {
  return frames.map((d, i) => tr.update(d, t0 + (i + 1) * HOP));
}
const GUITAR = [40, 45, 50, 55, 59, 64];
const make = (o: Partial<TrackerConfig> = {}) => new Tracker({ a4: 440, targets: [], locked: null, tolerance: 3, ...o });
const silence = (n: number) => Array.from({ length: n }, () => quiet());
const tone = (hz: number, n: number, o: Partial<Detection> = {}) => Array.from({ length: n }, () => det(hz, o));
const cents = (midi: number, c: number) => midiToHz(midi + c / 100);

describe('tracker (SPEC §5.4)', () => {
  it('chromatic: a note after silence opens after one confirming frame, settles stable, in tune within tolerance', () => {
    const tr = make();
    const s = feed(tr, [...silence(10), ...tone(cents(57, 2), 8)]);
    expect(s[10].cents).toBeNull(); // first frame only pending (confirmation)
    expect(s[11]).toMatchObject({ noteMidi: 57, targetMidi: 57, status: 'sharp' });
    expect(s[11].onset).toBe(false);
    expect(s[10].onset).toBe(true);
    const last = s[s.length - 1];
    expect(last).toMatchObject({ stable: true, status: 'inTune', displayCents: 2 });
    expect(last.cents).toBeCloseTo(2, 3);
  });

  it('flat/sharp by sign; inTune only when stable and |display| ≤ tolerance', () => {
    const tr = make({ tolerance: 1 });
    const s = feed(tr, [...silence(5), ...tone(cents(64, -2), 8)]);
    expect(s[s.length - 1]).toMatchObject({ status: 'flat', stable: true, displayCents: -2 });
  });

  it('isolated clicks (short, decayed inside the window) never open the gate', () => {
    const tr = make();
    const frames: Detection[] = [];
    for (let k = 0; k < 6; k++) frames.push(...silence(12), det(1800, { tail: 0.9 }), det(1800, { tail: 0.01 }), det(1800, { tail: 0.0 }));
    expect(feed(tr, frames).every((s) => s.cents === null)).toBe(true);
  });

  it('holds the last reading greyed for 1.5 s after the sound stops, then idle', () => {
    const tr = make();
    const s = feed(tr, [...silence(5), ...tone(220, 10), ...silence(60)]);
    const after = s.slice(15);
    const heldFrames = after.filter((x) => x.held && x.cents !== null).length;
    expect(heldFrames).toBeGreaterThanOrEqual(Math.floor(TRACKER.holdS * 30) - 1);
    expect(heldFrames).toBeLessThanOrEqual(Math.ceil(TRACKER.holdS * 30) + 1);
    expect(after[after.length - 1]).toMatchObject({ status: 'idle', cents: null, held: false });
  });

  it('noisy: loud sound without clarity for > 3 s shows "noisy"', () => {
    const tr = make();
    const s = feed(tr, [...silence(30), ...Array.from({ length: 120 }, () => det(300, { clarity: 0.5, rmsDb: -20 }))]);
    expect(s[40].status).toBe('listening');
    expect(s[s.length - 1].status).toBe('noisy');
  });

  it('instrument auto mode: a downward glide switches to the lower string after 0.06 s ≥ 50 cents nearer', () => {
    const tr = make({ targets: GUITAR });
    let s = feed(tr, [...silence(5), ...tone(cents(50, 30), 6)]); // D string, 30 cents sharp
    expect(s[s.length - 1]).toMatchObject({ stringIndex: 2, targetMidi: 50, status: 'sharp' });
    // The peg is loosened a lot: the pitch glides down 40 cents per frame (no onset). Past the midpoint the A string is
    // nearer by ≥ 50 cents; the target switches only after 3 such frames (0.067 s).
    const glide = Array.from({ length: 14 }, (_, i) => det(cents(50, 30 - 40 * (i + 1))));
    s = feed(tr, glide, 1);
    const firstA = s.findIndex((x) => x.stringIndex === 1);
    expect(firstA).toBeGreaterThan(0);
    const nearerByFifty = s.findIndex((x) => x.cents !== null && (x.hz ?? Infinity) < cents(45, 225)); // ≥ 50 cents nearer to A
    expect(firstA - nearerByFifty).toBeGreaterThanOrEqual(2);
  });

  it('S6: tightening a ringing string never switches to a higher string — "much too high", never "tighten"', () => {
    const tr = make({ targets: GUITAR });
    feed(tr, [...silence(5), ...tone(midiToHz(55), 6)]); // G string in tune
    // Tightened by +450 cents while it rings (reviewer probe t3: at +267 c it said "B string, flat −133").
    const glide = Array.from({ length: 30 }, (_, i) => det(cents(55, 15 * (i + 1))));
    const s = feed(tr, glide, 1);
    for (const x of s) {
      expect(x.targetMidi).toBe(55);
      expect(x.status).not.toBe('flat');
    }
    expect(s[s.length - 1].status).toBe('muchTooHigh');
  });

  it('a new onset re-chooses the string immediately', () => {
    const tr = make({ targets: GUITAR });
    feed(tr, [...silence(5), ...tone(midiToHz(40), 6)]);
    const s = feed(tr, [...silence(2), det(midiToHz(55), { rmsDb: -10 }), det(midiToHz(55), { rmsDb: -10 }), det(midiToHz(55), { rmsDb: -10 })], 1);
    expect(s[s.length - 1]).toMatchObject({ stringIndex: 3, targetMidi: 55 });
  });

  it('manual lock: only the locked string is the target; far above → "much too high", far below → "very low"', () => {
    const tr = make({ targets: GUITAR, locked: 0 });
    const s = feed(tr, [...silence(5), ...tone(midiToHz(47), 10)]); // B2 played, E2 locked: +700 cents
    for (const x of s.filter((y) => y.cents !== null)) {
      expect(x.targetMidi).toBe(40);
      expect(x.status).toBe('muchTooHigh');
    }
    const low = make({ targets: GUITAR, locked: 5 });
    const l = feed(low, [...silence(5), ...tone(midiToHz(50), 8)]); // D3 on the high-E string: −1400 cents
    expect(l[l.length - 1].status).toBe('veryLow');
  });

  it('between two strings and nearly equidistant: the lower string (instruction "loosen")', () => {
    const tr = make({ targets: GUITAR });
    // 245 cents above E2 = 255 cents below A2: ambiguous → E string, sharp.
    const s = feed(tr, [...silence(5), ...tone(cents(40, 245), 6)]);
    expect(s[s.length - 1]).toMatchObject({ stringIndex: 0, status: 'sharp' });
  });

  it('octave guard: after a stable reading, an octave jump without onset is ignored for 3 frames — once the note is gone', () => {
    // Fix round 3: the jump is the new octave only when the spectrum no longer holds the note itself (an octave slur);
    // the engine answers through aux.lowerPresent.
    const tr = make();
    feed(tr, [...silence(5), ...tone(110, 8)]);
    const gone = { lowerPresent: () => false };
    const s = tone(220, 5).map((d, i) => tr.update(d, 1 + (i + 1) * HOP, gone));
    expect(s.slice(0, 3).map((x) => Math.round(x.hz ?? 0))).toEqual([110, 110, 110]);
    expect(Math.round(s[4].hz ?? 0)).toBe(220);
  });

  it('fix round 3 — octave continuity: without an onset the note never jumps to its 2nd/3rd partial or a lone sub-harmonic', () => {
    // The note's fundamental fades and the window reads its 2nd partial (viola C3 tail, real set 1 `179`): same note.
    const tr = make({ targets: [48, 55, 62, 69] });
    feed(tr, [...silence(5), ...tone(130.81, 10)]);
    const up = tone(261.63, 12).map((d, i) => tr.update(d, 1 + (i + 1) * HOP, { lowerPresent: () => true }));
    for (const x of up) expect(x).toMatchObject({ targetMidi: 48, stringIndex: 0 });
    expect(up[up.length - 1].hz as number).toBeCloseTo(130.81, 0);
    // Locked mode: a sub-harmonic (a quarter of the note) in the tail is taken back to the note — never "very low"
    // (real set 1 `066`, double-bass A2 harmonic on locked A1 read as A0 27 Hz). 109.4 Hz on A1 stays 'harmonic'.
    const lk = make({ targets: [28, 33, 38, 43], locked: 1 });
    feed(lk, [...silence(5), ...tone(109.4, 10)]);
    const down = feed(lk, tone(27.35, 10), 1);
    for (const x of down) expect(x.status).toBe('harmonic');
    // …a lower note the detector proved (octaveFix 1/2) towards the locked string corrects the attack's octave (G1 on
    // locked A1 first read as G2, real set 1 `164`-like) …
    const a1 = make({ targets: [28, 33, 38, 43], locked: 1 });
    feed(a1, [...silence(5), ...tone(98, 10)]);
    const fixed = feed(a1, tone(49, 8, { octaveFix: 0.5 }), 15 * HOP); // right after: the note is young (≤ 0.5 s)
    expect(fixed[fixed.length - 1]).toMatchObject({ noteMidi: 31, targetMidi: 33, status: 'flat' });
    // …but never away from it: locked G2, played G2, a proven G1 below is taken back to G2.
    const g2 = make({ targets: [28, 33, 38, 43], locked: 3 });
    feed(g2, [...silence(5), ...tone(98, 10)]);
    expect(feed(g2, tone(49, 8, { octaveFix: 0.5 }), 1).pop()).toMatchObject({ noteMidi: 43, targetMidi: 43, status: 'inTune' });
    // …and not later in the note (a tail, a sympathetic string): 1 s after the attack the proven G1 is taken back.
    const late = make({ targets: [28, 33, 38, 43], locked: 1 });
    feed(late, [...silence(5), ...tone(98, 10)]);
    expect(feed(late, tone(49, 8, { octaveFix: 0.5 }), 1).pop()).toMatchObject({ noteMidi: 43, status: 'muchTooHigh' }); // G2 on A1, never 'tighten'
  });

  it('fix round 3 (L26): auto mode never picks a string from an estimate whose octave is unsure', () => {
    const tr = make({ targets: [28, 33, 38, 43] });
    const s = feed(tr, [...silence(5), ...tone(103.8, 6, { octaveAmbiguous: true })]);
    const shown = s.filter((x) => x.cents !== null);
    expect(shown.length).toBeGreaterThan(0);
    for (const x of shown) expect(x).toMatchObject({ octaveUnsure: true, stringIndex: null, targetMidi: 44 });
    // A trusted estimate without the doubt chooses the string.
    expect(feed(tr, tone(103.8, 3), 1).pop()).toMatchObject({ octaveUnsure: false, targetMidi: 43, stringIndex: 3 });
  });

  it('M4: no octave folding — a harmonic of the locked string is "harmonic", never "flat" (tighten)', () => {
    // Reviewer probe t13: locked high E, 7th-fret harmonic B5 (3 × E4, +1899 c) was folded twice → "−501 c, flat".
    const e = make({ targets: GUITAR, locked: 5 });
    const s = feed(e, [...silence(5), ...tone(3 * midiToHz(64) * Math.pow(2, -1 / 1200), 10)]);
    for (const x of s.filter((y) => y.cents !== null)) {
      expect(x).toMatchObject({ status: 'harmonic', harmonic: 3, targetMidi: 64, stringIndex: 5 });
      expect(x.cents as number).toBeGreaterThan(1850); // what was played, unfolded
      expect(x.harmonicCents as number).toBeCloseTo(-1, 0);
    }
    // Locked B, B4 10 cents below the 12th-fret harmonic (+1190 c): was "flat −10".
    const b = make({ targets: GUITAR, locked: 4 });
    const t = feed(b, [...silence(5), ...tone(2 * midiToHz(59) * Math.pow(2, -10 / 1200), 10)]);
    expect(t[t.length - 1]).toMatchObject({ status: 'harmonic', harmonic: 2 });
    expect(t[t.length - 1].harmonicCents as number).toBeCloseTo(-10, 0);
    // Locked G, its 3rd harmonic (+1902 c): "harmonic", not "much too high — loosen" for an in-tune string.
    const g = make({ targets: GUITAR, locked: 3 });
    expect(feed(g, [...silence(5), ...tone(3 * midiToHz(55), 10)]).pop()).toMatchObject({ status: 'harmonic', harmonic: 3 });
    // Auto mode, bass: an out-of-range note is not folded onto a string; it is "much too high" on the top string.
    const bass = make({ targets: [28, 33, 38, 43] });
    expect(feed(bass, [...silence(5), ...tone(midiToHz(65), 8)]).pop()).toMatchObject({ noteMidi: 65, targetMidi: 43, status: 'muchTooHigh' });
  });

  it('S7: locked and stringIndex use the as-played string numbers (re-entrant ukulele G4 C4 E4 A4)', () => {
    const uke = make({ targets: [67, 60, 64, 69], locked: 0 }); // the G string as the user sees it
    const s = feed(uke, [...silence(5), ...tone(midiToHz(67), 8)]);
    expect(s[s.length - 1]).toMatchObject({ targetMidi: 67, stringIndex: 0, status: 'inTune' }); // was C4, "much too high +700"
    const auto = make({ targets: [67, 60, 64, 69] });
    expect(feed(auto, [...silence(5), ...tone(midiToHz(60), 8)]).pop()).toMatchObject({ targetMidi: 60, stringIndex: 1 });
    // 12-string courses: both members carry the course number; locking course 0 tunes E2 or its octave E3.
    const twelve = make({ targets: [40, 52, 45, 57], strings: [0, 0, 1, 1], locked: 0 });
    expect(feed(twelve, [...silence(5), ...tone(midiToHz(52), 8)]).pop()).toMatchObject({ targetMidi: 52, stringIndex: 0, status: 'inTune' });
  });

  it('M3: a large jump without onset becomes a new segment after 0.09 s (its own timer)', () => {
    // Reviewer probe t16b: A2 stable, then D3 for 10 s without onset → 300/300 frames showed the live A2 reading.
    const tr = make({ targets: GUITAR });
    feed(tr, [det(110, { rmsDb: -90 }), ...tone(110, 11)]);
    const s = feed(tr, tone(146.83, 300), 1);
    const stale = s.filter((x) => x.hz !== null && Math.abs(x.hz - 110) < 0.5 && !x.held).length;
    expect(stale).toBeLessThanOrEqual(3);
    expect(s[s.length - 1]).toMatchObject({ noteMidi: 50, targetMidi: 50 });
  });

  it('M1: a closed attack frame never becomes the noise floor; the reading stays while the string rings and a re-pluck shows', () => {
    // Reviewer probe t15: the frame right after the pluck was closed (trimmed window, clarity 0.72) and entered the
    // floor at its own level; 3 s later it was the only floor frame and the ringing note (−27 dBFS) fell below it.
    const tr = make();
    const frames: Detection[] = [...silence(10), det(82.4, { clarity: 0.72, rmsDb: -19 })];
    for (let i = 0; i < 180; i++) frames.push(det(82.4, { rmsDb: -20 - (12 * i) / 180 })); // 6 s ringing, −20 → −32 dBFS
    frames.push(det(82.4, { rmsDb: -18 }), ...Array.from({ length: 30 }, () => det(82.4, { rmsDb: -19 }))); // re-pluck
    const s = feed(tr, frames);
    expect(s.slice(13, 191).every((x) => x.cents !== null && !x.held)).toBe(true);
    expect(s[s.length - 1]).toMatchObject({ noteMidi: 40, held: false });
  });

  it('S1: the rules are in seconds — the same input at 30 and 120 analyses per second gives the same timing', () => {
    const run = (rate: number) => {
      const tr = make({ targets: GUITAR });
      const out: TunerState[] = [];
      for (let i = 0; i < Math.round(rate * 1.5); i++) {
        const t = (i + 1) / rate;
        out.push(tr.update(t < 0.2 ? quiet() : t < 0.8 ? det(110) : det(146.83), t));
      }
      return out;
    };
    const firstT = (st: TunerState[], f: (x: TunerState) => boolean) => st.find(f)?.t ?? Infinity;
    const [a, b] = [run(30), run(120)];
    for (const f of [(x: TunerState) => x.status === 'inTune', (x: TunerState) => x.noteMidi === 50 && !x.held]) {
      expect(Math.abs(firstT(a, f) - firstT(b, f))).toBeLessThanOrEqual(1 / 30 + 1e-9);
    }
  });

  it('S4: steady notes in the old ±1 Hz hum band are shown when played; unplayed hum at the mains frequency is not', () => {
    // Reviewer probe t3/t11: a bowed B1 −30 c (60.67 Hz) and G2 +40 c (100.3 Hz) were hidden after 2 s.
    for (const hz of [60.67, 100.29, 49.27]) {
      const tr = make();
      const s = feed(tr, [...silence(10), ...tone(hz, 120, { rmsDb: -25 })]);
      expect(s.slice(12).every((x) => x.cents !== null && !x.held)).toBe(true);
    }
    // Unplayed (no onset) hum at 60.02 Hz is hidden; an unplayed tone 0.65 Hz away from it is a note.
    const hum = make();
    expect(feed(hum, Array.from({ length: 90 }, () => det(60.02, { rmsDb: -30 }))).every((x) => x.cents === null)).toBe(true);
    const near = make();
    expect(feed(near, Array.from({ length: 30 }, () => det(60.65, { rmsDb: -30 }))).pop()?.cents).not.toBeNull();
    // Hum that starts with a level rise (an amplifier switched on) is shown at first, hidden after 4 s steady.
    const amp = make();
    const a = feed(amp, [...silence(10), ...tone(60.01, 180, { rmsDb: -30 })]);
    expect(a[20].cents).not.toBeNull();
    expect(a.slice(10 + 125).every((x) => x.cents === null && x.hum)).toBe(true);
  });

  it('M2: after an onset, a residual (previous note removed) with a clear pitch shows the newest string', () => {
    const tr = make({ targets: GUITAR });
    feed(tr, [...silence(5), ...tone(82.41, 10)]); // E string ringing
    // A pluck on the A string: the raw window reads the common period 27.5 Hz (E2 + A2); the residual reads A2.
    const residual = (prev: number) => (Math.abs(prev - 82.41) < 1 ? det(110, { clarity: 0.97 }) : null);
    const frames = [det(27.5, { rmsDb: -10, clarity: 0.99 }), ...tone(27.5, 8, { rmsDb: -11, clarity: 0.99 })];
    const s = frames.map((d, i) => tr.update(d, (16 + i) * HOP, { residual }));
    expect(s[0].onset).toBe(true);
    expect(s[s.length - 1]).toMatchObject({ noteMidi: 45, targetMidi: 45, stringIndex: 1, held: false });
    // A residual pitch that is a multiple/sub-multiple of the removed note is never taken (vibrato leftovers).
    const tr2 = make();
    feed(tr2, [...silence(5), ...tone(440, 10)]);
    const half = () => det(220, { clarity: 0.98 });
    const r2 = [det(440, { rmsDb: -10 }), ...tone(440, 6, { rmsDb: -10 })].map((d, i) => tr2.update(d, (16 + i) * HOP, { residual: half }));
    expect(r2[r2.length - 1].noteMidi).toBe(69);
  });

  it('S3: windows with few periods after a trim never make a reading stable ("in tune")', () => {
    const tr = make();
    const s = feed(tr, [...silence(5), ...tone(midiToHz(27), 12, { trimmed: true, periods: 4 })]);
    expect(s.some((x) => x.stable)).toBe(false);
    const ok = feed(tr, tone(midiToHz(27), 6, { trimmed: false, periods: 6.8 }), 17 * HOP);
    expect(ok[ok.length - 1]).toMatchObject({ stable: true, status: 'inTune' });
  });

  it('mains hum alone (no onset) is never shown; a plucked note at the same pitch is', () => {
    const tr = make();
    const s = feed(tr, Array.from({ length: 120 }, () => det(60.02, { rmsDb: -30 })));
    expect(s.every((x) => x.cents === null)).toBe(true);
    expect(s.some((x) => x.hum)).toBe(true);
    const pluck = make();
    const p = feed(pluck, [...silence(10), ...tone(60.3, 10, { rmsDb: -15 })]);
    expect(p[p.length - 1].cents).not.toBeNull();
  });

  it('hum after a plucked note decays is not shown (a different pitch without onset)', () => {
    const tr = make();
    const s = feed(tr, [...silence(5), ...tone(238, 20, { rmsDb: -15 }), ...tone(59.6, 20, { rmsDb: -30 })]);
    const tail = s.slice(30);
    expect(tail.every((x) => x.cents === null || Math.round(x.hz ?? 0) === 238)).toBe(true);
  });

  it('a sub-harmonic (1/3) of the plucked note appearing without an attack is held greyed, not shown as a new note', () => {
    const tr = make();
    const s = feed(tr, [...silence(5), ...tone(197.9, 20, { rmsDb: -20 }), ...tone(197.9 / 3, 10, { rmsDb: -22 })]);
    for (const x of s.slice(25)) {
      expect(x.held).toBe(true);
      expect(Math.round(x.hz ?? 0)).toBe(198);
    }
  });

  it('a locked string within 30 cents of a hum frequency is still tuned', () => {
    const tr = make({ targets: [31, 36], locked: 0 }); // hypothetical: target G1 at A4 = 459 Hz → 51 Hz
    tr.setConfig({ a4: 449 }); // G1 ≈ 50.0 Hz
    const s = feed(tr, Array.from({ length: 30 }, () => det(50.05, { rmsDb: -25 })));
    expect(s[s.length - 1].cents).not.toBeNull();
  });

  it('integer display has ±0.6 hysteresis and steps by 1 for small changes', () => {
    const tr = make();
    feed(tr, [...silence(5), ...tone(cents(57, 1.4), 10)]);
    let s = feed(tr, tone(cents(57, 1.55), 10), 1); // 1.55 is within 0.6 of the displayed 1 → stays 1
    expect(s[s.length - 1].displayCents).toBe(1);
    s = feed(tr, tone(cents(57, 3.4), 20), 2);
    const shown = [1, ...s.map((x) => x.displayCents as number)];
    for (let i = 1; i < shown.length; i++) expect(Math.abs(shown[i] - shown[i - 1])).toBeLessThanOrEqual(1); // one step at a time
    expect(shown[shown.length - 1]).toBe(3);
    s = feed(tr, tone(cents(57, 30), 15), 3); // a big move: the display follows the smoothed needle directly
    expect(s[s.length - 1].displayCents).toBe(30);
  });

  it('window size: short at the start of a note, long once a low note has lasted two short windows', () => {
    const tr = make();
    expect(tr.windowSize(48000, 0)).toBe(4096);
    feed(tr, [...silence(5), ...tone(110, 2)]);
    expect(tr.windowSize(48000, 7 * HOP)).toBe(4096);
    feed(tr, tone(110, 10), 7 * HOP);
    expect(tr.windowSize(48000, 17 * HOP)).toBe(8192);
    const hi = make();
    feed(hi, [...silence(5), ...tone(880, 12)]);
    expect(hi.windowSize(48000, 17 * HOP)).toBe(4096);
    expect(make().windowSize(44100)).toBe(4096);
  });

  it('setConfig (tuning/lock change) restarts the string choice', () => {
    const tr = make({ targets: GUITAR });
    feed(tr, [...silence(5), ...tone(midiToHz(45), 6)]);
    tr.setConfig({ locked: 5 });
    const s = feed(tr, tone(midiToHz(45), 4), 1);
    expect(s[s.length - 1].targetMidi).toBe(64);
  });
});
