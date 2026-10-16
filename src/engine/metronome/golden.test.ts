/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildGolden, type GoldenVector } from '../../../scripts/gen-golden';

describe('golden vectors (test/golden/metronome.json, A10 native parity input)', () => {
  it('the checked-in file equals what the current engine generates (regenerate with scripts/gen-golden.ts)', () => {
    const file = JSON.parse(readFileSync(join(__dirname, '../../../test/golden/metronome.json'), 'utf8')) as { vectors: GoldenVector[] };
    const fresh = buildGolden();
    expect(file.vectors.length).toBe(600);
    const diffs = fresh.filter((v, i) => v.checksum !== file.vectors[i].checksum || v.head.join() !== file.vectors[i].head.join());
    expect(diffs.map((v) => `${v.id}@${v.sr}`)).toEqual([]);
    // Coverage of the features the native port must reproduce.
    const has = (f: (v: GoldenVector) => boolean) => fresh.filter(f).length;
    expect(has((v) => !!v.pattern.trainer)).toBeGreaterThan(50);
    expect(has((v) => !!v.pattern.poly)).toBeGreaterThan(50);
    expect(has((v) => !!v.pattern.mute)).toBeGreaterThan(50);
    expect(has((v) => v.pattern.pulse === 'dotted')).toBeGreaterThan(30);
    expect(has((v) => !!v.pattern.groups)).toBeGreaterThan(30);
    expect(has((v) => v.pattern.swing !== 0.5)).toBeGreaterThan(10);
    expect(has((v) => v.pattern.countInBars > 0)).toBeGreaterThan(50);
    expect(has((v) => v.updates.length > 0)).toBe(200);
  });
});
