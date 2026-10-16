/**
 * @jest-environment node
 */
import { mulberry32 } from '../synth/clicks';
import { PitchDetector, windowSize } from './detect';
import { runAll, summarize } from '../../../test/referee';

const tone = (hz: number, sr: number, n: number, harmonics: number[] = [1], phase = 0.3) => {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    harmonics.forEach((a, k) => (v += a * Math.sin(2 * Math.PI * hz * (k + 1) * (i / sr) + phase * (k + 1))));
    x[i] = 0.3 * v;
  }
  return x;
};
const err = (hz: number | null, truth: number) => (hz === null ? Infinity : Math.abs(1200 * Math.log2(hz / truth)));

describe('pitch detector (SPEC §5.3)', () => {
  it('pure tones 30.9 Hz – 2093 Hz at 44.1 and 48 kHz: within 0.35 cents in one window (0.5 below 35 Hz)', () => {
    const det = new PitchDetector();
    for (const sr of [44100, 48000]) {
      for (const hz of [30.87, 41.2, 55, 82.41, 110, 196, 440, 659.3, 1046.5, 1568, 2093]) {
        const w = windowSize(sr, hz < 70);
        expect(err(det.detect(tone(hz, sr, w), sr).hz, hz)).toBeLessThan(hz < 35 ? 0.5 : 0.35);
      }
    }
  });

  it('works at other sample rates (8–96 kHz)', () => {
    const det = new PitchDetector();
    for (const sr of [8000, 16000, 22050, 96000]) {
      const w = windowSize(sr, false);
      expect(err(det.detect(tone(220, sr, w), sr).hz, 220)).toBeLessThan(0.35);
    }
  });

  it('missing fundamental: harmonics 2–8 of 100 Hz read as 100 Hz', () => {
    const det = new PitchDetector();
    const d = det.detect(tone(100, 48000, 4096, [0, 1, 0.8, 0.6, 0.5, 0.4, 0.3, 0.2]), 48000);
    expect(err(d.hz, 100)).toBeLessThan(0.1);
    expect(d.firstPartial).toBe(false); // no energy at the fundamental: the NSDF period stands
  });

  it('inharmonic string: reports the first partial, not the stretched blend', () => {
    const sr = 48000;
    const f1 = 82.41;
    const b = 5e-4;
    const x = new Float32Array(4096);
    for (let k = 1; k <= 20; k++) {
      const f = f1 * k * Math.sqrt((1 + b * k * k) / (1 + b));
      for (let i = 0; i < x.length; i++) x[i] += (0.3 / k) * Math.sin(2 * Math.PI * f * (i / sr) + k);
    }
    const d = new PitchDetector().detect(x, sr);
    expect(d.firstPartial).toBe(true);
    expect(err(d.hz, f1)).toBeLessThan(0.3);
  });

  it('S5: weak fundamental under a steep phone-mic roll-off — partials 2 and 3 with the string law solved', () => {
    // Reviewer probe t7: E1 (41.2 Hz), B = 5e-4, 4th-order high-pass at 120 Hz → the NSDF blend read +13.6 cents.
    const sr = 48000;
    const f1 = 41.2;
    for (const b of [2e-4, 5e-4, 1e-3]) {
      const x = new Float32Array(8192);
      for (let k = 1; k <= 30; k++) {
        const f = f1 * k * Math.sqrt((1 + b * k * k) / (1 + b));
        const r = Math.pow(f / 120, 4);
        const g = r / Math.sqrt(1 + r * r);
        for (let i = 0; i < x.length; i++) x[i] += ((0.3 * Math.abs(Math.sin(Math.PI * k * 0.17))) / Math.pow(k, 1.3)) * g * Math.sin(2 * Math.PI * f * (i / sr) + k);
      }
      const d = new PitchDetector().detect(x, sr);
      expect(d.weakFundamental).toBe(true);
      expect(err(d.hz, f1)).toBeLessThan(1.5);
    }
  });

  it('silence → no pitch; white noise → low clarity', () => {
    const det = new PitchDetector();
    expect(det.detect(new Float32Array(4096), 48000).hz).toBeNull();
    const r = mulberry32(3);
    const noise = new Float32Array(4096).map(() => (r() * 2 - 1) * 0.1);
    const d = det.detect(noise, 48000);
    expect(d.clarity).toBeLessThan(0.85);
  });

  it('reports level, the NSDF near a lag, and the temporal tail', () => {
    const det = new PitchDetector();
    const x = tone(200, 48000, 4096);
    const d = det.detect(x, 48000);
    expect(d.rmsDb).toBeCloseTo(20 * Math.log10(0.3 / Math.SQRT2), 0);
    expect(det.nsdfNear(240)).toBeGreaterThan(0.99);
    expect(det.nsdfNear(120)).toBeLessThan(0);
    expect(d.tail).toBeGreaterThan(0.8);
    const click = new Float32Array(4096);
    for (let i = 1000; i < 1400; i++) click[i] = Math.sin(i) * Math.exp(-(i - 1000) / 100);
    expect(det.detect(click, 48000).tail).toBeLessThan(0.01);
  });

  it('window sizes: 4096 at 44.1/48 kHz, 8192 in low mode, scaled with the rate', () => {
    expect([windowSize(48000, false), windowSize(44100, false), windowSize(48000, true), windowSize(96000, false), windowSize(16000, false)]).toEqual([4096, 4096, 8192, 8192, 2048]);
  });

  it('reuses its buffers per window size (no allocation per call after warm-up)', () => {
    const det = new PitchDetector() as unknown as { buf: unknown; detect: PitchDetector['detect'] };
    const x = tone(300, 48000, 4096);
    det.detect(x, 48000);
    const first = det.buf;
    det.detect(x, 48000);
    expect(det.buf).toBe(first);
  });
});

describe('referee on the synthetic tuning set (every 4th fixture; full figures: scripts/referee.mjs)', () => {
  // Tuning-set figures (L27 rule 4): thresholds were tuned on this set, so passing here is NOT accuracy evidence.
  const s = summarize(runAll(4));
  const g = (name: string) => s.groups.find((x) => x.name.startsWith(name))!;

  it('A1: median ≤ 0.5 and p95 ≤ 1.0 cent (40–1000 Hz, SNR ≥ 20 dB); p95 ≤ 2.0 outside; inharmonic p95 ≤ 1.5', () => {
    expect(g('A1 40–1000').p50).toBeLessThanOrEqual(0.5);
    expect(g('A1 40–1000').p95).toBeLessThanOrEqual(1.0);
    expect(g('A1 1000–2100').p95).toBeLessThanOrEqual(2.0);
    expect(g('A1 30–40').p95).toBeLessThanOrEqual(2.0);
    expect(g('A1 inharmonic').p95).toBeLessThanOrEqual(1.5);
  });

  it('A3: right note on ≥ 99.5 % (≥ 20 dB) and ≥ 97 % (10 dB) of shown frames; hum alone and noise alone show nothing', () => {
    expect(s.noteCorrect20).toBeGreaterThanOrEqual(0.995);
    expect(s.noteCorrect10).toBeGreaterThanOrEqual(0.97);
    expect(s.noteCorrectHumUnder).toBeGreaterThanOrEqual(0.97);
    expect(s.humShown).toBe(0);
    expect(s.noiseShownShare).toBeLessThanOrEqual(0.01);
    expect(s.clicksShownShare).toBeLessThanOrEqual(0.01);
  });

  it('A4: never "flat" (tighten) while the PLAYED note (true frequency, never the folded reading) is above the target', () => {
    expect(s.unsafe).toBe(0); // played ≥ 1 octave above (SPEC A4), incl. harmonics on locked strings and auto-mode glides
    expect(s.unsafeSharp).toBe(0); // stricter: played ≥ 50 cents above, any fixture
  });

  it('sequences (review M1/M2/S4/S9): the newest note is shown while strings ring, re-plucks show, long notes stay', () => {
    const q = (k: string) => s.sequences.find((x) => x.kind === k)!;
    expect(q('nextString').coverage).toBeGreaterThanOrEqual(0.95); // was 0 % within 2 s (reviewer probe t1c)
    expect(q('pluckTrain').coverage).toBeGreaterThanOrEqual(0.9); // was 0 % from 4 s on (t14)
    expect(q('longRing').coverage).toBeGreaterThanOrEqual(0.98); // the reading vanished at onset + 3.0 s (t15)
    expect(q('bowedHumBand').coverage).toBeGreaterThanOrEqual(0.98); // hidden after 2 s as "hum" (t3)
    expect(q('glideUp').coverage).toBeGreaterThanOrEqual(0.95);
    expect(q('nextString').settledP95).toBeLessThanOrEqual(1.0);
    expect(s.longDecayLastSecondShown).toBeGreaterThanOrEqual(0.95); // 0/30 frames after 3.2 s (t2b)
  });

  it('A5: no octave flips on 4 s decays of E1/B0/E2; display steps ≤ 1 cent on steady tones', () => {
    expect(s.octaveFlipsLongDecay).toBe(0);
    expect(s.maxDisplayStepSteady).toBeLessThanOrEqual(1);
  });

  it('A5 settle — regression bound at the MEASURED values (SPEC p95 ≤ 0.150 / ≤ 0.300 s: low met, mid not; accepted 0.200 / 0.400)', () => {
    const mid = s.settle[0];
    const low = s.settle[1];
    expect(mid.never + low.never).toBe(0);
    expect(mid.p50).toBeLessThanOrEqual(0.14); // fix round 2: stable after 3 estimates (0.067 s), was 0.167
    expect(mid.p95).toBeLessThanOrEqual(0.17); // was 0.200
    expect(low.p95).toBeLessThanOrEqual(0.31); // was 0.400
    // Fix round 2: notes below ≈ 59 Hz show no reading before a window of ≥ 5 periods (the rough short window read up to
    // +29 c), so the first right-note frame of a bass note comes 2–3 frames later (p95 4 → 7 frames, low notes only).
    expect(s.latencyFrames.p95).toBeLessThanOrEqual(7);
  });
});
