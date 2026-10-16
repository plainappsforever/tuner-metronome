// Writes the click tables (6 kits × 5 voices × 44.1/48 kHz, float32 little-endian mono raw PCM) into
// modules/music-audio/assets/clicks/ plus manifest.json (lengths + FNV-1a checksums). Deterministic: re-running gives
// byte-identical files. Run: node --import ./scripts/ts-hooks.mjs scripts/gen-sounds.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

import { KITS, renderClick, VOICES } from '../src/engine/synth/clicks.ts';
import { fnv1a32 } from '../src/engine/metronome/schedule.ts';

const dir = 'modules/music-audio/assets/clicks';
mkdirSync(dir, { recursive: true });
const manifest = { format: 'f32le-mono', generator: 'scripts/gen-sounds.mjs', tables: [] };
for (const sr of [44100, 48000]) {
  for (const kit of KITS) {
    for (const voice of VOICES) {
      const x = renderClick(kit, voice, sr);
      const bytes = Buffer.from(x.buffer, x.byteOffset, x.byteLength);
      const name = `${kit}-${voice}-${sr}.f32`;
      writeFileSync(`${dir}/${name}`, bytes);
      manifest.tables.push({ name, kit, voice, sr, frames: x.length, fnv1a32: fnv1a32(bytes.toString('latin1')) });
    }
  }
}
writeFileSync(`${dir}/manifest.json`, `${JSON.stringify(manifest, null, 1)}\n`);
console.log(`wrote ${manifest.tables.length} click tables to ${dir}`);
