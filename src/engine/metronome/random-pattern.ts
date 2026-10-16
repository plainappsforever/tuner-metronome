// Seeded random patterns covering every schedule feature (golden vectors for the native parity test, A10).
import { mulberry32 } from '../synth/clicks';
import { LEVELS, normalizePattern, type Pattern } from './pattern';

export function randomPattern(seed: number): Pattern {
  const r = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const kind = r();
  let beats = int(1, 16);
  let pulse: 'unit' | 'dotted' = 'unit';
  let groups: number[] | undefined;
  if (kind < 0.15) {
    beats = pick([6, 9, 12]);
    pulse = 'dotted';
  } else if (kind < 0.3) {
    groups = [];
    let left = int(5, 13);
    beats = left;
    while (left > 0) {
      const g = Math.min(left, int(2, 3));
      groups.push(g);
      left -= g;
    }
  }
  const pulsesChoice = pick([
    [[0, 1]],
    [[0, 1], [1, 2]],
    [[0, 1], [1, 3], [2, 3]],
    [[0, 1], [1, 4], [1, 2], [3, 4]],
    [[0, 1], [1, 5], [2, 5], [3, 5], [4, 5]],
    [[0, 1], [1, 6], [1, 3], [1, 2], [2, 3], [5, 6]],
    [[0, 1], [1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]],
    [[0, 1], [3, 4]],
    [[0, 1], [2, 3]],
  ]);
  const pattern: Record<string, unknown> = {
    v: 1,
    bpm: int(10, 400),
    beats,
    unit: pick([2, 4, 8, 16]),
    pulse,
    groups,
    accents: Array.from({ length: beats }, () => pick(LEVELS)),
    sub: { pulses: pulsesChoice.map(([num, den]) => ({ num, den, level: pick(LEVELS) })) },
    swing: pulsesChoice.length === 2 && pulsesChoice[1][1] === 2 && r() < 0.6 ? int(50, 75) / 100 : 0.5,
    sounds: { accent: 'click', beat: 'click', sub: 'click', poly: 'wood', countIn: 'beep' },
    volume: 0.8,
    countInBars: r() < 0.3 ? int(1, 2) : 0,
  };
  if (r() < 0.3) pattern.poly = { n: int(2, 16), level: pick(LEVELS), sound: 'wood' };
  if (r() < 0.3) {
    const start = int(10, 400);
    pattern.trainer = {
      startBpm: start,
      targetBpm: int(10, 400),
      stepBpm: int(1, 20),
      every: r() < 0.5 ? { bars: int(1, 8) } : { seconds: int(5, 20) },
      mode: r() < 0.5 ? 'once' : 'cycle',
    };
  }
  if (r() < 0.25) pattern.mute = r() < 0.5 ? { playBars: int(1, 4), muteBars: int(1, 4) } : { randomPercent: int(0, 75), seed: int(1, 1e6) };
  return normalizePattern(pattern);
}
