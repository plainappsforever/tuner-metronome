// Runs the tuner engine (detector + tracker, 30 analyses per second) on WAV files and prints one JSON object per file:
// { file, sampleRate, frames: [{ t, hz, noteMidi, targetMidi, stringIndex, cents, displayCents, status, stable, held,
//   harmonic, harmonicCents }] }
// For the P4 blind-set checker: it needs no knowledge of src/engine/. Reads 16/24/32-bit PCM and 32-bit float WAV
// (mono, or the first channel).
// t = signal time (s) of the newest sample in the analysed window. The first frame comes once one full window
// (≈ 85 ms) has arrived. hz = what was played (never folded into the instrument's range).
// --targets: MIDI notes in the order the strings are played/numbered (any order; e.g. re-entrant ukulele 67,60,64,69).
// --locked i: 0-based index into --targets as given (fix round 1, review S7 — before, it indexed the SORTED list).
// stringIndex: the same as-given index. status adds 'harmonic' (2nd/3rd/4th partial of the target string: harmonic,
// harmonicCents = deviation from that partial).
// Usage: node --import ./scripts/ts-hooks.mjs scripts/tuner-json.mjs [--a4 440] [--targets 40,45,50,55,59,64]
//        [--locked 0] [--tolerance 3] file.wav ...
import { readFileSync } from 'node:fs';

import { runOffline } from '../src/engine/pitch/stream.ts';

function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not a WAV file`);
  let at = 12;
  let fmt = null;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
      if (fmt.format === 0xfffe) fmt.format = b.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE sub-format
    } else if (id === 'data') {
      if (!fmt) throw new Error(`${path}: data before fmt`);
      const bytes = fmt.bits / 8;
      const frames = Math.floor(size / (bytes * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const o = body + i * bytes * fmt.channels;
        if (fmt.format === 3 && fmt.bits === 32) out[i] = b.readFloatLE(o);
        else if (fmt.bits === 16) out[i] = b.readInt16LE(o) / 32768;
        else if (fmt.bits === 24) out[i] = b.readIntLE(o, 3) / 8388608;
        else if (fmt.bits === 32) out[i] = b.readInt32LE(o) / 2147483648;
        else throw new Error(`${path}: unsupported ${fmt.bits}-bit format ${fmt.format}`);
      }
      return { samples: out, sampleRate: fmt.rate };
    }
    at = body + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const a4 = Number(opt('--a4', '440'));
const targets = (opt('--targets', '') || '').split(',').filter(Boolean).map(Number);
const lockedRaw = opt('--locked', null);
const tolerance = Number(opt('--tolerance', '3'));
for (const file of args) {
  const { samples, sampleRate } = readWav(file);
  const states = runOffline(samples, sampleRate, { a4, targets, locked: lockedRaw === null ? null : Number(lockedRaw), tolerance });
  const frames = states.map((s) => ({
    t: Number(s.t.toFixed(6)),
    hz: s.hz,
    noteMidi: s.noteMidi,
    targetMidi: s.targetMidi,
    stringIndex: s.stringIndex,
    cents: s.cents,
    displayCents: s.displayCents,
    status: s.status,
    stable: s.stable,
    held: s.held,
    harmonic: s.harmonic,
    harmonicCents: s.harmonicCents,
  }));
  console.log(JSON.stringify({ file, sampleRate, frames }));
}
