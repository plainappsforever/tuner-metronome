import { midiToHz } from '../notes';
import { renderTone, TONE_LEVEL, ToneVoice } from './tone';

/** Frequency from interpolated upward zero crossings (test-side measurement; the blind O3 oracle is separate). */
function measureHz(x: Float32Array, sr: number, skip: number): number {
  const crossings: number[] = [];
  for (let i = skip + 1; i < x.length - skip; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) crossings.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  }
  return ((crossings.length - 1) * sr) / (crossings[crossings.length - 1] - crossings[0]);
}

describe('reference tone (SPEC §5.8, A9 TS part)', () => {
  it('renders the exact target frequency (±0.01 cent over 10 s) for C2–C6 at A4 415 / 440 / 466', () => {
    let worst = 0;
    for (const a4 of [415, 440, 466]) {
      for (let m = 36; m <= 84; m++) {
        const hz = midiToHz(m, a4);
        const sr = m % 2 ? 44100 : 48000;
        const x = renderTone(hz, sr, 10);
        const cents = 1200 * Math.log2(measureHz(x, sr, Math.round(0.02 * sr)) / hz);
        worst = Math.max(worst, Math.abs(cents));
      }
    }
    expect(worst).toBeLessThan(0.01);
  });

  it('has a 15 ms attack, a 60 ms release, the −12 dBFS fundamental level and no clipping', () => {
    const sr = 48000;
    const x = renderTone(440, sr, 1);
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(1);
    expect(peak).toBeGreaterThan(TONE_LEVEL); // harmonics add on top of the fundamental
    expect(Math.abs(x[0])).toBe(0);
    expect(x[x.length - 1]).toBeCloseTo(0, 3);
    const v = new ToneVoice(440, sr);
    const buf = new Float32Array(Math.round(0.2 * sr));
    v.render(buf);
    v.stop();
    expect(v.done).toBe(false);
    v.render(new Float32Array(Math.round(0.06 * sr)));
    expect(v.done).toBe(true);
  });
});
