// Node timing of one detector analysis (W 4096 / 8192) on a plucked guitar-like tone. These are V8 figures on this
// Mac; the SPEC §5.3 budget (≤ 4 ms / ≤ 8 ms) is for Hermes on the Android emulator and is measured in P3 (S3).
// Run: node --import ./scripts/ts-hooks.mjs scripts/bench-detector.mjs
import { PitchDetector } from '../src/engine/pitch/detect.ts';
import { Tracker } from '../src/engine/pitch/tracker.ts';

const sr = 48000;
function pluck(hz, n) {
  const x = new Float32Array(n);
  for (let k = 1; k <= 20; k++) {
    const f = hz * k * Math.sqrt((1 + 1e-4 * k * k) / 1.0001);
    for (let i = 0; i < n; i++) x[i] += (0.3 / k) * Math.exp(-i / sr / 1.5) * Math.sin(2 * Math.PI * f * (i / sr) + k);
  }
  return x;
}
for (const w of [4096, 8192]) {
  const det = new PitchDetector();
  const tr = new Tracker({ a4: 440, targets: [40, 45, 50, 55, 59, 64], locked: null, tolerance: 3 });
  const x = pluck(110, w);
  for (let i = 0; i < 200; i++) det.detect(x, sr); // warm-up (JIT)
  const times = [];
  for (let i = 0; i < 1000; i++) {
    const t0 = performance.now();
    const d = det.detect(x, sr);
    tr.update(d, i / 30);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`W ${w}: detector+tracker p50 ${times[500].toFixed(3)} ms, p95 ${times[950].toFixed(3)} ms, max ${times[999].toFixed(3)} ms (Node ${process.version}, V8)`);
}

// Whole engine per analysis (fix round 1): detector + onset spectrum + tracker, and with the residual detector running
// (a second string plucked while the first rings: two detector runs per analysis until raw alone serves for 0.3 s).
const { TunerEngine } = await import('../src/engine/pitch/stream.ts');
for (const [label, build] of [
  ['single E2 pluck', () => pluck(82.41, 6 * sr)],
  ['E2 ringing + A2 plucked', () => { const a = pluck(82.41, 6 * sr); const b = pluck(110, 5 * sr); for (let i = 0; i < b.length; i++) a[sr + i] += b[i]; return a; }],
]) {
  const x = build();
  const times = [];
  let runs = 0;
  for (let rep = 0; rep < 3; rep++) {
    const e = new TunerEngine(sr, { a4: 440, targets: [40, 45, 50, 55, 59, 64], locked: null, tolerance: 3 });
    for (let at = 0; at + 1600 <= x.length; at += 1600) {
      const t0 = performance.now();
      e.push(x.subarray(at, at + 1600));
      if (rep > 0) times.push(performance.now() - t0);
    }
    runs = e.residualRuns / e.analyses;
  }
  times.sort((a, b) => a - b);
  const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(3);
  console.log(`engine, ${label}: per analysis p50 ${q(0.5)} ms, p95 ${q(0.95)} ms, max ${q(1)} ms; residual on ${(100 * runs).toFixed(0)} % of analyses`);
}
