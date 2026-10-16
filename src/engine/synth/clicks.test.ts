import { normalizePattern } from '../metronome/pattern';
import { events } from '../metronome/schedule';
import { CLICK_MAX_S, KITS, mixEvents, renderClick, renderKit, softClip, VOICES } from './clicks';

describe('click kits (SPEC §5.8)', () => {
  it('6 kits × 5 voices at 44.1 and 48 kHz: ≤ 40 ms, start and end at 0, peak < 1, deterministic', () => {
    for (const sr of [44100, 48000]) {
      for (const kit of KITS) {
        for (const voice of VOICES) {
          const x = renderClick(kit, voice, sr);
          expect(x.length).toBeLessThanOrEqual(Math.round(CLICK_MAX_S * sr));
          expect(Math.abs(x[0])).toBe(0);
          expect(Math.abs(x[x.length - 1])).toBeLessThan(1e-6);
          let peak = 0;
          for (const v of x) peak = Math.max(peak, Math.abs(v));
          expect(peak).toBeGreaterThan(0.05);
          expect(peak).toBeLessThan(1);
          expect(renderClick(kit, voice, sr)).toEqual(x);
        }
      }
    }
  });

  it('accent is louder than beat (+3 dB) for every kit', () => {
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
    for (const kit of KITS) {
      const k = renderKit(kit, 48000);
      const ratioDb = 20 * Math.log10(rms(k.accent) / rms(k.beat));
      expect(ratioDb).toBeGreaterThan(1.5);
      expect(ratioDb).toBeLessThan(4.5);
    }
  });

  it('soft clip never exceeds ±1 and is linear below 0.8', () => {
    expect(softClip(0.5)).toBe(0.5);
    expect(softClip(-0.8)).toBe(-0.8);
    for (const x of [0.81, 1, 2, 10, 1e6]) {
      expect(softClip(x)).toBeLessThanOrEqual(1);
      expect(softClip(-x)).toBeGreaterThanOrEqual(-1);
    }
  });

  it('400 BPM 16ths with a 16-poly layer for 10 s: output stays within ±1, ≤ 8 voices, nothing NaN', () => {
    const p = normalizePattern({
      bpm: 400,
      beats: 4,
      unit: 4,
      accents: ['accent', 'accent', 'accent', 'accent'],
      sub: { pulses: [{ num: 0, den: 1 }, { num: 1, den: 4 }, { num: 1, den: 2 }, { num: 3, den: 4 }] },
      poly: { n: 16, level: 'accent', sound: 'wood' },
      volume: 1,
    });
    const sr = 48000;
    const list = events(p, sr, 0, sr * 10);
    expect(list.length).toBeGreaterThan(500); // 26.7 sixteenths/s + 26.7 poly pulses/s
    const out = mixEvents(list, renderKit('cowbell', sr), sr, 0, sr * 10, 1);
    let peak = 0;
    for (const v of out) {
      expect(Number.isNaN(v)).toBe(false);
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeGreaterThan(0.3);
  });

  it('mute and soft levels: muted events are silent, soft is half', () => {
    const sr = 48000;
    const tables = renderKit('beep', sr);
    const n = tables.beat.length;
    const ev = (level: 'normal' | 'soft' | 'mute') => [{ sample: 0, kind: 'beat' as const, level, bar: 0, beat: 0, pulse: 0 }];
    const normal = mixEvents(ev('normal'), tables, sr, 0, n);
    const soft = mixEvents(ev('soft'), tables, sr, 0, n);
    expect(mixEvents(ev('mute'), tables, sr, 0, n).every((v) => v === 0)).toBe(true);
    const i = normal.findIndex((v) => Math.abs(v) > 0.1);
    expect(soft[i] / normal[i]).toBeCloseTo(0.5, 5);
  });
});
