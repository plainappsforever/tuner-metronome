import { MIN_SESSION_SECONDS, PracticeClock, totals, weekStart } from './practice';

const local = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('practice log maths (SPEC §5.9)', () => {
  it('week starts Monday 00:00 local time', () => {
    // 2026-10-16 is a Friday.
    expect(weekStart(local(2026, 10, 16, 15))).toBe(local(2026, 10, 12, 0));
    expect(weekStart(local(2026, 10, 12, 0, 0))).toBe(local(2026, 10, 12, 0));
    expect(weekStart(local(2026, 10, 18, 23, 59))).toBe(local(2026, 10, 12, 0)); // Sunday
    expect(weekStart(local(2026, 10, 19, 0, 1))).toBe(local(2026, 10, 19, 0)); // next Monday
  });

  it('totals this week and all time, minutes rounded down', () => {
    const now = local(2026, 10, 16, 18);
    const sessions = [
      { startedAt: local(2026, 10, 11, 23), seconds: 600 }, // last Sunday: all time only
      { startedAt: local(2026, 10, 12, 0, 5), seconds: 119 },
      { startedAt: local(2026, 10, 16, 9), seconds: 1801 },
    ];
    expect(totals(sessions, now)).toEqual({ weekSeconds: 1920, allSeconds: 2520, weekMinutes: 32, allMinutes: 42 });
    expect(totals([], now)).toEqual({ weekSeconds: 0, allSeconds: 0, weekMinutes: 0, allMinutes: 0 });
  });

  it('audible time excludes pauses; under 20 s is not saved; BPM range tracked', () => {
    const c = new PracticeClock();
    c.start(0, 100);
    c.pause(15_000);
    c.start(60_000, 100); // 45 s pause excluded
    c.tempo(120);
    expect(c.finish(64_999)).toBeNull(); // 19.999 s audible
    const d = new PracticeClock();
    d.start(0, 90);
    d.tempo(84);
    d.tempo(132);
    expect(d.finish(MIN_SESSION_SECONDS * 1000)).toEqual({ seconds: 20, bpmMin: 84, bpmMax: 132 });
  });
});
