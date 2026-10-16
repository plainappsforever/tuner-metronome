import { mulberry32 } from '../synth/clicks';
import { OnsetDetector } from './onset';
import { AnalysisStream, runOffline, TunerEngine } from './stream';

const sr = 48000;
/** Plucked-like harmonic tone (partials decay faster with k), added into `x` from second `at`. */
function pluck(x: Float32Array, at: number, f: number, amp = 0.2, tau = 2) {
  const r = mulberry32(Math.round(f * 100));
  for (let k = 1; k <= 20; k++) {
    if (k * f > 0.45 * sr) break;
    const ph = r() * 6.28;
    const a = (amp * Math.abs(Math.sin(Math.PI * k * 0.2))) / Math.pow(k, 1.2);
    for (let i = Math.round(at * sr), n = 0; i < x.length; i++, n++) x[i] += a * Math.exp(-n / sr / (tau / (1 + 0.3 * (k - 1)))) * Math.sin(ph + (2 * Math.PI * k * f * n) / sr);
  }
}
const floor = (x: Float32Array) => {
  const r = mulberry32(5);
  for (let i = 0; i < x.length; i++) x[i] += (r() - 0.5) * 2e-4;
  return x;
};

describe('TunerEngine (stream.ts)', () => {
  it('S1: analyses at a fixed signal-time hop whatever the chunk size (the UI rate does not change the readings)', () => {
    const x = new Float32Array(Math.round(1.5 * sr));
    pluck(x, 0.2, 196);
    floor(x);
    const cfg = { a4: 440, targets: [40, 45, 50, 55, 59, 64], locked: null, tolerance: 3 };
    const ref = runOffline(x, sr, cfg);
    for (const chunk of [400, 1000, 4800]) {
      const e = new TunerEngine(sr, cfg);
      const got = [];
      for (let at = 0; at < x.length; at += chunk) {
        const s = e.push(x.subarray(at, Math.min(x.length, at + chunk)));
        if (s) got.push(s);
      }
      for (const s of got) {
        const r = ref.find((y) => Math.abs(y.t - s.t) < 1e-9);
        expect(r).toBeDefined();
        expect(s.status).toBe(r?.status);
        expect(s.hz).toBe(r?.hz);
      }
      expect(e.analyses).toBe(ref.length); // 30 per second of signal, however the pushes were sized
    }
  });

  it('M1: a string that already rings when the tuner starts is shown at once and stays shown (no floor lock-out)', () => {
    const x = new Float32Array(Math.round(5 * sr));
    pluck(x, 0, 82.41, 0.3, 3); // full level from the first sample, no onset
    const st = runOffline(floor(x), sr, { a4: 440, targets: [40, 45, 50, 55, 59, 64], locked: null, tolerance: 3 });
    const shown = st.filter((s) => s.t > 0.15 && s.hz !== null && !s.held);
    expect(shown.length).toBe(st.filter((s) => s.t > 0.15).length);
  });

  it('runs at most `maxPerPush` analyses when a lot of audio arrives at once (the newest ones)', () => {
    const e = new TunerEngine(sr, { a4: 440, targets: [], locked: null, tolerance: 3 });
    const s = e.push(new Float32Array(sr), 4); // 1 s = 30 hops due
    expect(e.analyses).toBe(4);
    expect(s?.t).toBeCloseTo(1, 6);
  });

  it('M2: a second string plucked while the first rings is shown within 0.15 s, on its string', () => {
    const cfg = { a4: 440, targets: [40, 45, 50, 55, 59, 64], locked: null, tolerance: 3 };
    for (const [a, b] of [[82.41, 110], [110, 82.41], [146.83, 196], [196, 246.94], [329.63, 246.94]]) {
      const x = new Float32Array(Math.round(3 * sr));
      pluck(x, 0.2, a);
      pluck(x, 1.2, b); // same force; the first string still rings at −4 dB
      const st = runOffline(floor(x), sr, cfg);
      const first = st.find((s) => s.t > 1.2 && s.hz !== null && !s.held && Math.abs(1200 * Math.log2(s.hz / b)) < 50);
      expect(first).toBeDefined();
      expect((first?.t ?? 9) - 1.2).toBeLessThanOrEqual(0.15);
      const later = st.filter((s) => s.t > 1.5 && s.t < 3);
      expect(later.every((s) => s.hz !== null && !s.held && Math.abs(1200 * Math.log2(s.hz / b)) < 1)).toBe(true);
    }
  });
});

describe('OnsetDetector (onset.ts)', () => {
  const measure = (x: Float32Array) => {
    const st = new AnalysisStream(sr);
    const od = new OnsetDetector(sr);
    const out = [];
    for (let at = 0; at + 1600 <= x.length; at += 1600) {
      st.push(x.subarray(at, at + 1600));
      out.push({ t: st.total / sr, ...od.update(st.window(od.n)) });
    }
    return out;
  };
  it('a new string over a ringing one: novelty ≥ 0.3 and a level rise; a decaying note alone: novelty < 0.3', () => {
    const x = new Float32Array(Math.round(2.5 * sr));
    pluck(x, 0.2, 82.41);
    const y = x.slice();
    pluck(y, 1.2, 110);
    const ring = measure(floor(x)).filter((m) => m.t > 0.4);
    expect(Math.max(...ring.map((m) => m.novelty))).toBeLessThan(0.3);
    const second = measure(floor(y)).filter((m) => m.t > 1.2 && m.t < 1.3);
    expect(second.some((m) => m.novelty >= 0.3 && m.riseDb >= 1.5)).toBe(true);
  });
});
