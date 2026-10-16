import { mulberry32 } from '../synth/clicks';
import { autocorrelate } from './fft';

function naive(x: Float64Array): Float64Array {
  const r = new Float64Array(x.length);
  for (let t = 0; t < x.length; t++) {
    let s = 0;
    for (let j = 0; j + t < x.length; j++) s += x[j] * x[j + t];
    r[t] = s;
  }
  return r;
}

describe('FFT autocorrelation', () => {
  it.each([4, 7, 64, 100, 1000, 4096])('matches the direct sum for length %i', (len) => {
    const rnd = mulberry32(len);
    const x = new Float64Array(len).map(() => rnd() * 2 - 1);
    let n = 4;
    while (n < 2 * len) n <<= 1;
    const out = new Float64Array(len);
    autocorrelate(x, len, n, out);
    const ref = naive(x);
    let worst = 0;
    for (let t = 0; t < len; t++) worst = Math.max(worst, Math.abs(out[t] - ref[t]));
    expect(worst).toBeLessThan(1e-9 * Math.max(1, ref[0]));
  });
});
