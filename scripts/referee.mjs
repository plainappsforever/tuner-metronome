// Prints the tuning-set referee report (A1/A3/A4/A5) and the slowest fixtures. Full set; Jest runs a subset.
// Run: node --import ./scripts/ts-hooks.mjs scripts/referee.mjs [--json]
import { runAll, summarize, quantile } from '../test/referee.ts';

const t0 = Date.now();
const results = runAll(1);
const s = summarize(results);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(s, null, 1));
} else {
  const f = (x) => (Number.isFinite(x) ? x.toFixed(3) : '—');
  console.log(`fixtures ${s.fixtures}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log('group | fixtures | frames | p50 | p90 | p95 | p99 | max | raw p50 | raw p95   (|cents error| of the displayed reading after it settled)');
  for (const g of s.groups) console.log(`${g.name} | ${g.fixtures} | ${g.frames} | ${f(g.p50)} | ${f(g.p90)} | ${f(g.p95)} | ${f(g.p99)} | ${f(g.max)} | ${f(g.rawP50)} | ${f(g.rawP95)}`);
  console.log('ALL shown frames incl. the attack (S9 b) | frames | p50 | p95 | p99 | max | coverage (shown / frames in [onset, end])');
  for (const g of s.groups) console.log(`${g.name} | ${g.allFrames} | ${f(g.allP50)} | ${f(g.allP95)} | ${f(g.allP99)} | ${f(g.allMax)} | ${(100 * g.coverage).toFixed(1)} %`);
  console.log('SEQUENCES (tuning material, S9) | fixtures | newest note shown live on its string | worst fixture | settled p95 | all-frames p95 | flat while ≥ 50 c above | statuses');
  for (const q of s.sequences) console.log(`${q.kind} | ${q.fixtures} | ${(100 * q.coverage).toFixed(1)} % | ${q.worst} | ${f(q.settledP95)} | ${f(q.allP95)} | ${q.unsafe} | ${JSON.stringify(q.statuses)}`);
  console.log(`long 4 s decays: share of frames in the last second showing a reading ${(100 * s.longDecayLastSecondShown).toFixed(1)} % (M1)`);
  console.log(`A3 right note on shown frames: SNR ≥ 20 dB ${(100 * s.noteCorrect20).toFixed(2)} %, 10 dB ${(100 * s.noteCorrect10).toFixed(2)} %, hum under note ${(100 * s.noteCorrectHumUnder).toFixed(2)} %`);
  console.log(`A3 hum-alone frames showing a note: ${s.humShown}; noise-only share ${(100 * s.noiseShownShare).toFixed(2)} %; clicks-only share ${(100 * s.clicksShownShare).toFixed(2)} %`);
  console.log(`A4 (played note ≥ 1 octave above the target, judged on the TRUE frequency): 'flat' frames ${s.unsafe}; stricter — 'flat' while the played note is ≥ 50 cents above: ${s.unsafeSharp}`);
  for (const g of s.settle) console.log(`A5 settle ${g.name}: n ${g.n}, p50 ${f(g.p50)} s, p95 ${f(g.p95)} s, max ${f(g.max)} s, never ${g.never}`);
  console.log(`latency (frames from onset to first right-note reading, 30 analyses/s): p50 ${s.latencyFrames.p50}, p95 ${s.latencyFrames.p95}, max ${s.latencyFrames.max}`);
  console.log(`A5 octave flips on 4 s decays (E1, B0, E2): ${s.octaveFlipsLongDecay}; max display step on steady tones: ${s.maxDisplayStepSteady}`);
  const worst = results.filter((r) => r.errors.length).map((r) => ({ id: r.id, hz: r.hz, p95: quantile(r.errors, 0.95) })).sort((a, b) => b.p95 - a.p95).slice(0, 12);
  console.log('worst fixtures (p95):', worst.map((w) => `${w.id}@${w.hz.toFixed(1)}:${w.p95.toFixed(2)}`).join(' '));
  const never = results.filter((r) => r.hz !== null && r.settleS === null).map((r) => `${r.id}@${r.hz.toFixed(1)}`);
  console.log(`never settled (${never.length}):`, never.slice(0, 30).join(' '));
}
