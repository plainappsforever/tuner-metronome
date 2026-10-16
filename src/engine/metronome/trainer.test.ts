import { barRandom, bpmForBar, hash32, isMutedBar, trainerBpmForStep, trainerValues } from './trainer';

const tr = (o: object) => ({ startBpm: 80, targetBpm: 120, stepBpm: 4, every: { bars: 4 }, mode: 'once' as const, ...o });

describe('speed trainer (SPEC §5.6)', () => {
  it('steps from start to target, clamping the last step', () => {
    expect(trainerValues(tr({}))).toEqual([80, 84, 88, 92, 96, 100, 104, 108, 112, 116, 120]);
    expect(trainerValues(tr({ stepBpm: 15 }))).toEqual([80, 95, 110, 120]);
    expect(trainerValues(tr({ startBpm: 120, targetBpm: 100, stepBpm: 7 }))).toEqual([120, 113, 106, 100]);
    expect(trainerValues(tr({ targetBpm: 80 }))).toEqual([80]);
  });

  it('bpmForBar by bars: once holds the target, cycle restarts', () => {
    expect([0, 3, 4, 7, 8, 39, 40, 41, 400].map((b) => bpmForBar(tr({}), b))).toEqual([80, 80, 84, 84, 88, 116, 120, 120, 120]);
    const c = tr({ mode: 'cycle', every: { bars: 1 }, targetBpm: 88 });
    expect([0, 1, 2, 3, 4, 5].map((b) => bpmForBar(c, b))).toEqual([80, 84, 88, 80, 84, 88]);
    expect(trainerBpmForStep(c, 3001)).toBe(84);
  });

  it('seconds-mode trainers refuse the bar-only shortcut', () => {
    expect(() => bpmForBar(tr({ every: { seconds: 10 } }), 3)).toThrow();
  });
});

describe('mute cycle', () => {
  it('play/mute repeating from the origin bar', () => {
    const m = { playBars: 3, muteBars: 2 };
    expect(Array.from({ length: 10 }, (_, b) => isMutedBar(m, b))).toEqual([false, false, false, true, true, false, false, false, true, true]);
    expect(isMutedBar(undefined, 5)).toBe(false);
    expect(isMutedBar(m, -1)).toBe(false);
  });

  it('random mute: the first bar plays, the share follows the percentage, 0 % never mutes', () => {
    const muted = (pct: number) => Array.from({ length: 2000 }, (_, b) => isMutedBar({ randomPercent: pct, seed: 9 }, b)).filter(Boolean).length;
    expect(isMutedBar({ randomPercent: 75, seed: 1 }, 0)).toBe(false);
    expect(muted(0)).toBe(0);
    expect(muted(25) / 2000).toBeGreaterThan(0.21);
    expect(muted(25) / 2000).toBeLessThan(0.29);
  });

  it('hash is a fixed 32-bit function (native ports must reproduce these values)', () => {
    expect([hash32(0), hash32(1), hash32(0xffffffff)]).toEqual([0, 1753845952, 1734902346]);
    expect([barRandom(1, 1), barRandom(1, 2), barRandom(42, 7)]).toEqual([92, 14, 17]);
  });
});
