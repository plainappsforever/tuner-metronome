import { mulberry32 } from '../synth/clicks';
import { DEFAULT_PATTERN, normalizePattern, type Pattern } from './pattern';
import { divRound, events, firstEvents, Scheduler, type MetronomeEvent } from './schedule';

// Loose input on purpose: normalizePattern fills sub-pulse levels, accents etc. like it does for stored JSON.
const P = (over: Record<string, unknown> = {}): Pattern => normalizePattern({ ...DEFAULT_PATTERN, ...over });

/** Exact round-half-up of n/d with BigInt (test-only oracle). */
const exactRound = (n: bigint, d: bigint) => (2n * n + d) / (2n * d);

describe('divRound (integer formula, SPEC §5.5)', () => {
  it('equals exact BigInt rounding on 200,000 random cases', () => {
    const rnd = mulberry32(7);
    const rates = [8000, 22050, 44100, 48000, 96000];
    let mismatches = 0;
    for (let i = 0; i < 200_000; i++) {
      const sr = rates[Math.floor(rnd() * rates.length)];
      const bpm = 10 + Math.floor(rnd() * 391);
      const q = rnd() < 0.2 ? 3 : 1;
      const den = rnd() < 0.1 ? 100 : 1 + Math.floor(rnd() * 16);
      const k = Math.floor(rnd() * (rnd() < 0.5 ? 1000 : 3_000_000));
      const num = Math.floor(rnd() * den);
      const n = (k * den + num) * 60 * sr;
      const d = bpm * q * den;
      if (BigInt(divRound(n, d)) !== exactRound(BigInt(n), BigInt(d))) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it('rounds halves up and is exact near 2^52', () => {
    expect(divRound(1, 2)).toBe(1);
    expect(divRound(3, 2)).toBe(2);
    expect(divRound(5, 4)).toBe(1);
    const n = 2 ** 51 + 12345;
    expect(BigInt(divRound(n, 7))).toBe(exactRound(BigInt(n), 7n));
  });
});

describe('constant tempo: zero drift and ≤ ½ sample per click', () => {
  it('1 hour at 48 kHz, 120 BPM: beat 7200 is exactly sample 172,800,000', () => {
    const list = events(P({ bpm: 120 }), 48000, 172_800_000 - 30000, 172_800_001);
    const last = list[list.length - 1];
    expect(last).toMatchObject({ sample: 172_800_000, bar: 1800, beat: 0, kind: 'accent' });
  });

  it.each([
    [133, 48000],
    [97, 44100],
    [400, 44100],
    [10, 48000],
    [59, 22050],
  ])('jitter at %i BPM / %i Hz over 1 hour: every click within ½ sample of the exact time', (bpm, sr) => {
    const s = new Scheduler(P({ bpm, beats: 4 }), sr);
    const L = (60 * sr) / bpm;
    let prev = -1;
    let worst = 0;
    const end = 3600 * sr;
    let k = 0;
    for (;;) {
      const e = s.next();
      if (e.sample > end) break;
      const exact = Number(exactRound(BigInt(k) * 60n * BigInt(sr), BigInt(bpm)));
      expect(e.sample).toBe(exact);
      worst = Math.max(worst, Math.abs(e.sample - k * L));
      if (prev >= 0) expect([Math.floor(L), Math.ceil(L)]).toContain(e.sample - prev);
      prev = e.sample;
      k++;
    }
    expect(worst).toBeLessThanOrEqual(0.5);
  });
});

describe('pattern features', () => {
  const at48 = (p: Pattern, n: number) => firstEvents(p, 48000, n);

  it('accents and levels per unit; mute level emitted (visual only)', () => {
    const list = at48(P({ accents: ['accent', 'soft', 'mute', 'normal'] }), 4);
    expect(list.map((e) => [e.kind, e.level, e.beat])).toEqual([
      ['accent', 'accent', 0],
      ['beat', 'soft', 1],
      ['beat', 'mute', 2],
      ['beat', 'normal', 3],
    ]);
    expect(list.map((e) => e.sample)).toEqual([0, 28800, 57600, 86400]);
  });

  it('subdivisions: triplets at round((3u + i)·L/3)', () => {
    const p = P({ bpm: 70, sub: { pulses: [{ num: 0, den: 1 }, { num: 1, den: 3, level: 'soft' }, { num: 2, den: 3, level: 'soft' }] } });
    const list = at48(p, 9);
    const expected = Array.from({ length: 9 }, (_, i) => Number(exactRound(BigInt(i) * 60n * 48000n, 70n * 3n)));
    expect(list.map((e) => e.sample)).toEqual(expected);
    expect(list.slice(0, 3).map((e) => [e.kind, e.pulse])).toEqual([
      ['accent', 0],
      ['sub', 1],
      ['sub', 2],
    ]);
  });

  it('swing moves the second of two eighths to the swing fraction', () => {
    const p = P({ bpm: 120, swing: 0.6, sub: { pulses: [{ num: 0, den: 1 }, { num: 1, den: 2 }] } });
    const list = at48(p, 4);
    expect(list.map((e) => e.sample)).toEqual([0, 14400, 24000, 38400]);
    // Without swing: exactly half.
    expect(at48(P({ bpm: 120, sub: { pulses: [{ num: 0, den: 1 }, { num: 1, den: 2 }] } }), 2)[1].sample).toBe(12000);
  });

  it('compound meter: 6/8 dotted at 60 BPM counts dotted quarters (units = eighths at 1/3 s)', () => {
    const p = P({ bpm: 60, beats: 6, unit: 8, pulse: 'dotted', accents: undefined });
    const list = at48(p, 7);
    expect(list.map((e) => e.sample)).toEqual([0, 16000, 32000, 48000, 64000, 80000, 96000]);
    expect(list.map((e) => e.kind)).toEqual(['accent', 'sub', 'sub', 'beat', 'sub', 'sub', 'accent']);
  });

  it('grouped meter: 7/8 as 2+2+3 has counted beats on units 0, 2, 4', () => {
    const p = P({ bpm: 240, beats: 7, unit: 8, groups: [2, 2, 3], accents: undefined });
    expect(at48(p, 7).map((e) => e.kind)).toEqual(['accent', 'sub', 'beat', 'sub', 'beat', 'sub', 'sub']);
  });

  it('polyrhythm 3 over 4/4: barStart + round(j·4L/3)', () => {
    const p = P({ bpm: 90, poly: { n: 3, level: 'normal', sound: 'wood' } });
    const list = events(p, 48000, 0, 2 * 4 * 32000).filter((e) => e.kind === 'poly');
    expect(list.map((e) => e.sample)).toEqual([0, 42667, 85333, 128000, 170667, 213333]);
    expect(list.map((e) => e.bar)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('count-in: 1 bar of countIn clicks before bar 0, at the same tempo', () => {
    const list = at48(P({ bpm: 120, countInBars: 1 }), 6);
    expect(list.map((e) => [e.kind, e.bar, e.sample])).toEqual([
      ['countIn', -1, 0],
      ['countIn', -1, 24000],
      ['countIn', -1, 48000],
      ['countIn', -1, 72000],
      ['accent', 0, 96000],
      ['beat', 0, 120000],
    ]);
  });

  it('events() is deterministic and lazy-consistent for any window', () => {
    const p = P({ bpm: 173, beats: 5, poly: { n: 4, level: 'soft', sound: 'wood' }, sub: { pulses: [{ num: 0, den: 1 }, { num: 1, den: 2 }] } });
    const all = events(p, 44100, 0, 44100 * 30);
    const window = events(p, 44100, 44100 * 10, 44100 * 11);
    expect(window).toEqual(all.filter((e) => e.sample >= 44100 * 10 && e.sample < 44100 * 11));
    // Sorted by time, ties broken deterministically.
    for (let i = 1; i < all.length; i++) expect(all[i].sample).toBeGreaterThanOrEqual(all[i - 1].sample);
  });
});

describe('trainer and mute cycle inside the schedule', () => {
  const barStarts = (list: MetronomeEvent[]) => list.filter((e) => e.beat === 0 && e.pulse === 0 && e.kind !== 'poly');

  it('speed trainer by bars: 80 → 120, +4 every 4 bars, steps exactly at bar lines (once)', () => {
    const p = P({ trainer: { startBpm: 80, targetBpm: 120, stepBpm: 4, every: { bars: 4 }, mode: 'once' } });
    const s = new Scheduler(p, 48000);
    const units: MetronomeEvent[] = [];
    while (units.length < 4 * 60) units.push(s.next());
    const bars = barStarts(units);
    // Bar durations equal the exact bar length of that bar's tempo to within 1 sample.
    for (let b = 0; b + 1 < bars.length; b++) {
      const bpm = Math.min(120, 80 + 4 * Math.floor(b / 4));
      const len = bars[b + 1].sample - bars[b].sample;
      expect(Math.abs(len - (4 * 60 * 48000) / bpm)).toBeLessThanOrEqual(1);
    }
    const lastBar = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    expect(lastBar.sample - prev.sample).toBe(96000); // 120 BPM reached and held
  });

  it('speed trainer cycle restarts at the start tempo after holding the target for one step', () => {
    const p = P({ trainer: { startBpm: 100, targetBpm: 108, stepBpm: 4, every: { bars: 1 }, mode: 'cycle' } });
    const s = new Scheduler(p, 48000);
    const bars: number[] = [];
    let last = -1;
    while (bars.length < 8) {
      const e = s.next();
      if (e.beat === 0 && e.bar !== last) {
        bars.push(e.sample);
        last = e.bar;
      }
    }
    const tempos = bars.slice(1).map((x, i) => Math.round((4 * 60 * 48000) / (x - bars[i])));
    expect(tempos).toEqual([100, 104, 108, 100, 104, 108, 100]);
  });

  it('speed trainer by seconds: steps at the first bar line ≥ 5 s after the previous step', () => {
    // 60 BPM 4/4: bars of 4 s → steps at bars 2, 4, 6 … (8 s ≥ 5 s); 3 s bars at 80 BPM → every 2nd bar.
    const p = P({ trainer: { startBpm: 60, targetBpm: 80, stepBpm: 20, every: { seconds: 5 }, mode: 'once' } });
    const list = events(p, 48000, 0, 48000 * 20).filter((e) => e.beat === 0 && e.pulse === 0);
    expect(list.map((e) => e.sample / 48000)).toEqual([0, 4, 8, 11, 14, 17]);
  });

  it('ramp down is allowed (start > target)', () => {
    const p = P({ trainer: { startBpm: 120, targetBpm: 110, stepBpm: 5, every: { bars: 1 }, mode: 'once' } });
    const list = events(p, 48000, 0, 48000 * 12).filter((e) => e.beat === 0);
    const lens = list.slice(1).map((e, i) => e.sample - list[i].sample);
    expect(lens.slice(0, 3)).toEqual([96000, divRound(4 * 60 * 48000, 115), divRound(4 * 60 * 48000, 110)]);
  });

  it('count-in bars are not counted by trainer or mute cycle', () => {
    const p = P({
      bpm: 120,
      countInBars: 2,
      mute: { playBars: 1, muteBars: 1 },
      trainer: { startBpm: 120, targetBpm: 140, stepBpm: 20, every: { bars: 1 }, mode: 'once' },
    });
    const list = events(p, 48000, 0, 48000 * 10);
    expect(list.filter((e) => e.bar < 0).every((e) => e.kind === 'countIn' && e.level === 'normal')).toBe(true);
    const bar0 = list.filter((e) => e.bar === 0);
    const bar1 = list.filter((e) => e.bar === 1);
    expect(bar0[0].sample).toBe(2 * 96000);
    expect(bar0.every((e) => e.level !== 'mute')).toBe(true);
    expect(bar1.every((e) => e.level === 'mute')).toBe(true);
    expect(bar0[1].sample - bar0[0].sample).toBe(24000); // bar 0 at the start tempo 120
    expect(bar1[1].sample - bar1[0].sample).toBe(divRound(60 * 48000, 140)); // bar 1 = first step
  });

  it('mute cycle play 2 / mute 1: bars 2, 5, 8 muted; random mute is reproducible from the seed', () => {
    const list = events(P({ bpm: 240, mute: { playBars: 2, muteBars: 1 } }), 48000, 0, 48000 * 9);
    const muted = [...new Set(list.filter((e) => e.level === 'mute').map((e) => e.bar))];
    expect(muted).toEqual([2, 5, 8]);
    const r = (seed: number) =>
      [...new Set(events(P({ bpm: 240, mute: { randomPercent: 50, seed } }), 48000, 0, 48000 * 60).filter((e) => e.level === 'mute').map((e) => e.bar))];
    expect(r(42)).toEqual(r(42));
    expect(r(42)).not.toEqual(r(43));
    expect(r(42)).not.toContain(0);
    const share = r(42).length / 60;
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.7);
  });
});

describe('live updates (SPEC §5.5: edits at the next beat, meter/trainer at the bar line)', () => {
  it('a BPM edit applies at the next beat; nothing before it changes; no double or missing click', () => {
    const p = P({ bpm: 100, sub: { pulses: [{ num: 0, den: 1 }, { num: 1, den: 2 }] } });
    const a = new Scheduler(p, 48000);
    const ref = new Scheduler(p, 48000);
    const got: MetronomeEvent[] = [];
    for (let i = 0; i < 3; i++) got.push(a.next()); // beat 0, its 8th, beat 1
    for (let i = 0; i < 3; i++) ref.next();
    const boundary = a.update({ ...p, bpm: 150 }, 'beat');
    expect(boundary).toBe(ref.next().sample === 43200 ? 57600 : -1); // the 8th of beat 1 (43200) stays, beat 2 at 57600
    for (let i = 0; i < 6; i++) got.push(a.next());
    expect(got.map((e) => e.sample)).toEqual([0, 14400, 28800, 43200, 57600, 67200, 76800, 86400, 96000]);
    expect(got.map((e) => `${e.bar}:${e.beat}:${e.pulse}`)).toEqual(['0:0:0', '0:0:1', '0:1:0', '0:1:1', '0:2:0', '0:2:1', '0:3:0', '0:3:1', '1:0:0']);
  });

  it('a meter change waits for the bar line; units continue on the same grid', () => {
    const p = P({ bpm: 120 });
    const a = new Scheduler(p, 48000);
    a.next();
    a.next();
    const boundary = a.update(P({ bpm: 120, beats: 3, accents: undefined }), 'beat');
    expect(boundary).toBe(96000);
    const rest = Array.from({ length: 6 }, () => a.next());
    expect(rest.map((e) => [e.sample, e.bar, e.beat])).toEqual([
      [48000, 0, 2],
      [72000, 0, 3],
      [96000, 1, 0],
      [120000, 1, 1],
      [144000, 1, 2],
      [168000, 2, 0],
    ]);
  });

  it('an edit before the first event of a bar applies at that bar line', () => {
    const p = P({ bpm: 120 });
    const a = new Scheduler(p, 48000);
    for (let i = 0; i < 4; i++) a.next(); // whole bar 0 returned
    expect(a.update({ ...p, bpm: 60 }, 'bar')).toBe(96000);
    expect([a.next().sample, a.next().sample]).toEqual([96000, 144000]);
  });

  it('with a trainer running, an edit waits for the bar line and a new trainer restarts at that bar', () => {
    const tr = { startBpm: 80, targetBpm: 100, stepBpm: 10, every: { bars: 1 }, mode: 'once' as const };
    const a = new Scheduler(P({ trainer: tr }), 48000);
    a.next();
    const boundary = a.update(P({ trainer: { ...tr, startBpm: 60 } }), 'beat');
    expect(boundary).toBe(divRound(4 * 60 * 48000, 80));
    const evs: MetronomeEvent[] = [];
    while (evs.filter((e) => e.beat === 0).length < 3) evs.push(a.next());
    const starts = evs.filter((e) => e.beat === 0).map((e) => e.sample);
    expect(starts[0]).toBe(boundary);
    expect(starts[1] - starts[0]).toBe(divRound(4 * 60 * 48000, 60));
    expect(starts[2] - starts[1]).toBe(divRound(4 * 60 * 48000, 70));
  });
});
