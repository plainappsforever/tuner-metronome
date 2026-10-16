import { markingFor, MARKINGS } from './markings';
import { TapTempo } from './tap';

describe('tap tempo (SPEC §5.7)', () => {
  it('first result after 2 taps; median of the last up-to-4 intervals', () => {
    const t = new TapTempo();
    expect(t.tap(0)).toBeNull();
    expect(t.tap(500)).toBe(120);
    expect(t.tap(1000)).toBe(120);
    expect(t.tap(1520)).toBe(120); // [500, 500, 520] → median 500
    expect(t.tap(2040)).toBe(118); // [500, 500, 520, 520] → 510 ms → 117.6
    expect(t.tap(2560)).toBe(115); // [500, 520, 520, 520] → median 520 ms → 115.4
  });

  it('resets after 2 s without a tap', () => {
    const t = new TapTempo();
    t.tap(0);
    t.tap(600);
    expect(t.tap(2700)).toBeNull();
    expect(t.tap(3200)).toBe(120);
  });

  it('a > 40 % change switches only when the next interval confirms it (review S8)', () => {
    const t = new TapTempo();
    t.tap(0);
    t.tap(1000);
    t.tap(2000);
    expect(t.tap(2500)).toBe(60); // 500 vs median 1000: a candidate, the tempo stays
    expect(t.tap(3000)).toBe(120); // confirmed: the new tempo from both intervals
    expect(t.tap(3500)).toBe(120);
  });

  it('one late tap changes nothing (reviewer probe m3-tap: was 120, 80, 240, 120)', () => {
    const t = new TapTempo();
    expect([0, 500, 1000, 1750, 2000, 2500, 3000].map((ms) => t.tap(ms))).toEqual([null, 120, 120, 120, 120, 120, 120]);
    const early = new TapTempo();
    expect([0, 500, 1000, 1370, 2000, 2500].map((ms) => early.tap(ms))).toEqual([null, 120, 120, 120, 120, 120]);
  });

  it('a finger bounce (< 150 ms) is ignored, never 400 BPM (probe: was 120, 400, 130, 125)', () => {
    const t = new TapTempo();
    expect([0, 500, 1000, 1040, 1500, 2000, 2500].map((ms) => t.tap(ms))).toEqual([null, 120, 120, 120, 120, 120, 120]);
  });

  it('a real tempo change takes one confirming tap', () => {
    const t = new TapTempo();
    expect([0, 500, 1000, 1500, 2500, 3500, 4500].map((ms) => t.tap(ms))).toEqual([null, 120, 120, 120, 120, 60, 60]);
  });

  it('clamps to 10–400 and ignores non-monotonic time', () => {
    const t = new TapTempo();
    t.tap(0);
    expect(t.tap(100)).toBeNull(); // a bounce: ignored
    expect(t.tap(150)).toBe(400); // exactly 400 BPM
    const u = new TapTempo();
    u.tap(1000);
    expect(u.tap(900)).toBeNull();
  });
});

describe('tempo markings', () => {
  it('cover 10–400 without gaps or overlaps; set values lie inside their ranges', () => {
    for (let b = 10; b <= 400; b++) expect(MARKINGS.filter((m) => b >= m.lo && b <= m.hi)).toHaveLength(1);
    for (const m of MARKINGS) {
      expect(m.set).toBeGreaterThanOrEqual(m.lo);
      expect(m.set).toBeLessThanOrEqual(m.hi);
    }
  });

  it('names a tempo', () => {
    expect(markingFor(120).id).toBe('allegro');
    expect(markingFor(119).id).toBe('moderato');
    expect(markingFor(39).id).toBe('grave');
    expect(markingFor(250).id).toBe('prestissimo');
  });
});
