// Real FFT via a half-size complex radix-2 FFT (packing trick), preallocated per size: no allocation per call after
// the first use of a size. Used for the FFT autocorrelation in detect.ts.

type Plan = {
  m: number; // complex size = n / 2
  rev: Uint32Array;
  cos: Float64Array; // twiddles of the complex FFT, size m/2
  sin: Float64Array;
  wr: Float64Array; // post-processing twiddles e^{-2πik/n}, size m
  wi: Float64Array;
  re: Float64Array;
  im: Float64Array;
};

const plans = new Map<number, Plan>();

function plan(n: number): Plan {
  let p = plans.get(n);
  if (p) return p;
  if (n < 4 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two ≥ 4, got ${n}`);
  const m = n >> 1;
  const bits = Math.log2(m);
  const rev = new Uint32Array(m);
  for (let i = 0; i < m; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(m >> 1 || 1);
  const sin = new Float64Array(m >> 1 || 1);
  for (let i = 0; i < m >> 1; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / m);
    sin[i] = Math.sin((-2 * Math.PI * i) / m);
  }
  const wr = new Float64Array(m);
  const wi = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    wr[k] = Math.cos((-2 * Math.PI * k) / n);
    wi[k] = Math.sin((-2 * Math.PI * k) / n);
  }
  p = { m, rev, cos, sin, wr, wi, re: new Float64Array(m), im: new Float64Array(m) };
  plans.set(n, p);
  return p;
}

/** In-place complex FFT of size m (forward when sign = -1, unnormalised inverse when sign = +1). */
function complexFft(p: Plan, sign: -1 | 1): void {
  const { m, rev, cos, sin, re, im } = p;
  for (let i = 0; i < m; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let size = 2; size <= m; size <<= 1) {
    const half = size >> 1;
    const step = m / size;
    for (let start = 0; start < m; start += size) {
      for (let k = 0; k < half; k++) {
        // twiddle w = e^{sign·2πik/size} = c + i·sw (the table holds the forward, negative-angle sine)
        const c = cos[k * step];
        const sw = sign < 0 ? sin[k * step] : -sin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * c - im[b] * sw;
        const xi = im[b] * c + re[b] * sw;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

const powerBuffers = new Map<number, Float64Array>();

/**
 * Autocorrelation r[τ] = Σ_j x[j]·x[j+τ] for τ = 0 … len−1 of `x` (length len), via a real FFT of size n ≥ 2·len
 * (zero padding, so no circular wrap-around). Writes into `out` (length ≥ len). `n` must be a power of two.
 */
export function autocorrelate(x: Float64Array | Float32Array, len: number, n: number, out: Float64Array): void {
  const p = plan(n);
  const { m, re, im, wr, wi } = p;
  let power = powerBuffers.get(n);
  if (!power) powerBuffers.set(n, (power = new Float64Array(m + 1)));
  // Forward real FFT: pack z[j] = x[2j] + i·x[2j+1] (zero padded), Z = FFT_m(z).
  for (let j = 0; j < m; j++) {
    const a = 2 * j;
    re[j] = a < len ? x[a] : 0;
    im[j] = a + 1 < len ? x[a + 1] : 0;
  }
  complexFft(p, -1);
  // X[k] = E[k] + W^k·O[k], E = (Z[k] + conj Z[m−k])/2, O = (Z[k] − conj Z[m−k])/(2i); P[k] = |X[k]|², k = 0 … m.
  for (let k = 0; k <= m; k++) {
    const k1 = k % m;
    const k2 = (m - k) % m;
    const ar = re[k1];
    const ai = im[k1];
    const br = re[k2];
    const bi = -im[k2]; // conj
    const er = (ar + br) / 2;
    const ei = (ai + bi) / 2;
    // (a − b)/(2i) = −i(a − b)/2
    const or = (ai - bi) / 2;
    const oi = -(ar - br) / 2;
    const c = k < m ? wr[k] : -1; // W^m = e^{−iπ} = −1
    const sn = k < m ? wi[k] : 0;
    const xr = er + c * or - sn * oi;
    const xi = ei + c * oi + sn * or;
    power[k] = xr * xr + xi * xi;
  }
  // Inverse real FFT of the even, real spectrum P: Y[k] = E'[k] + i·O'[k] with E' = (P[k] + P[m−k])/2 and
  // O' = (P[k] − P[m−k])·conj(W^k)/2; then r[2j] + i·r[2j+1] = IFFT_m(Y)[j] / m.
  for (let k = 0; k < m; k++) {
    const pk = power[k];
    const pmk = power[m - k];
    const e = (pk + pmk) / 2;
    const d = (pk - pmk) / 2;
    const or = d * wr[k];
    const oi = -d * wi[k];
    re[k] = e - oi; // E' + i·O' (E' real)
    im[k] = or;
  }
  complexFft(p, 1);
  const scale = 1 / m;
  for (let j = 0; j < m && 2 * j < len; j++) {
    out[2 * j] = re[j] * scale;
    if (2 * j + 1 < len) out[2 * j + 1] = im[j] * scale;
  }
}

/**
 * Forward real FFT of `x` (length len, zero padded to n): writes X[k] for k = 0 … n/2 into re/im (length ≥ n/2 + 1).
 */
export function realFft(x: Float64Array | Float32Array, len: number, n: number, outRe: Float64Array, outIm: Float64Array): void {
  const p = plan(n);
  const { m, re, im, wr, wi } = p;
  for (let j = 0; j < m; j++) {
    const a = 2 * j;
    re[j] = a < len ? x[a] : 0;
    im[j] = a + 1 < len ? x[a + 1] : 0;
  }
  complexFft(p, -1);
  for (let k = 0; k <= m; k++) {
    const k1 = k % m;
    const k2 = (m - k) % m;
    const ar = re[k1];
    const ai = im[k1];
    const br = re[k2];
    const bi = -im[k2];
    const er = (ar + br) / 2;
    const ei = (ai + bi) / 2;
    const or = (ai - bi) / 2;
    const oi = -(ar - br) / 2;
    const c = k < m ? wr[k] : -1;
    const sn = k < m ? wi[k] : 0;
    outRe[k] = er + c * or - sn * oi;
    outIm[k] = ei + c * oi + sn * or;
  }
}
