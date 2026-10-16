// Golden vectors for the native scheduler parity self-test (SPEC §5.5, A10).
// Run: node --import ./scripts/ts-hooks.mjs scripts/gen-golden.ts   (deterministic; writes test/golden/metronome.json)
//
// Per vector: the pattern, the sample rate, optional live updates (installed after N events), the FNV-1a 32 checksum of
// the first COUNT event lines ("sample,kind,level,bar,beat,pulse\n" each), and the first HEAD events in full so a
// mismatch can be located. The native self-test (P6) runs the same list through its Swift/Kotlin scheduler.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { randomPattern } from '../src/engine/metronome/random-pattern';
import { eventLine, eventsChecksum, Scheduler, type MetronomeEvent } from '../src/engine/metronome/schedule';
import { mulberry32 } from '../src/engine/synth/clicks';
import type { Pattern } from '../src/engine/metronome/pattern';

export const PATTERNS = 300;
export const COUNT = 4000;
const HEAD = 16;

export type GoldenUpdate = { afterEvents: number; at: 'beat' | 'bar'; pattern: Pattern };
export type GoldenVector = { id: number; sr: number; pattern: Pattern; updates: GoldenUpdate[]; count: number; checksum: number; head: string[] };

export function runVector(pattern: Pattern, sr: number, updates: GoldenUpdate[], count: number): MetronomeEvent[] {
  const s = new Scheduler(pattern, sr);
  const out: MetronomeEvent[] = [];
  let ui = 0;
  while (out.length < count) {
    while (ui < updates.length && updates[ui].afterEvents === out.length) {
      s.update(updates[ui].pattern, updates[ui].at);
      ui++;
    }
    out.push(s.next());
  }
  return out;
}

export function buildGolden(): GoldenVector[] {
  const vectors: GoldenVector[] = [];
  for (let i = 0; i < PATTERNS; i++) {
    const pattern = randomPattern(1000 + i);
    const r = mulberry32(5000 + i);
    const updates: GoldenUpdate[] = [];
    if (i % 3 === 0) {
      let after = 0;
      for (let k = 0; k < 3; k++) {
        after += 1 + Math.floor(r() * 800);
        updates.push({ afterEvents: after, at: r() < 0.5 ? 'beat' : 'bar', pattern: randomPattern(90000 + i * 10 + k) });
      }
    }
    for (const sr of [44100, 48000]) {
      const list = runVector(pattern, sr, updates, COUNT);
      vectors.push({ id: i, sr, pattern, updates, count: COUNT, checksum: eventsChecksum(list), head: list.slice(0, HEAD).map(eventLine) });
    }
  }
  return vectors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = 'test/golden/metronome.json';
  mkdirSync(dirname(file), { recursive: true });
  const vectors = buildGolden();
  writeFileSync(file, `${JSON.stringify({ version: 1, generator: 'scripts/gen-golden.ts', vectors })}\n`);
  console.log(`wrote ${vectors.length} vectors (${PATTERNS} patterns × 2 rates × ${COUNT} events) to ${file}`);
}
