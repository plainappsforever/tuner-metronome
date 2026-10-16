// Notes and pitch maths (SPEC §5.1). Pure TypeScript, no React Native imports; relative imports only so Node scripts
// (scripts/ts-hooks.mjs) can run the same code.

export const A4_MIN = 415;
export const A4_MAX = 466;
export const A4_DEFAULT = 440;
export const MIDI_A4 = 69;

/** Frequency of MIDI note `m` (may be fractional) at reference `a4`: f = a4 · 2^((m − 69)/12). */
export function midiToHz(m: number, a4: number = A4_DEFAULT): number {
  return a4 * Math.pow(2, (m - MIDI_A4) / 12);
}

/** Fractional MIDI note of frequency `f`. */
export function hzToMidi(f: number, a4: number = A4_DEFAULT): number {
  return MIDI_A4 + 12 * Math.log2(f / a4);
}

/** Cents of `f` against `target`: 1200 · log2(f / target). Positive = sharp. */
export function centsBetween(f: number, target: number): number {
  return 1200 * Math.log2(f / target);
}

export type NearestNote = { midi: number; cents: number };

/** Nearest equal-tempered note with cents in [−50, +50). */
export function nearestNote(f: number, a4: number = A4_DEFAULT): NearestNote {
  const m = hzToMidi(f, a4);
  // floor(m + 0.5) puts exactly −50 cents on the upper note: x.5 belongs to the next note, so cents ∈ [−50, +50).
  const midi = Math.floor(m + 0.5);
  return { midi, cents: (m - midi) * 100 };
}

export type NoteSystem = 'letter' | 'german' | 'solfege';
export type Accidental = 'sharp' | 'flat';

const SHARP = '♯'; // ♯
const FLAT = '♭'; // ♭

const LETTER_SHARP = ['C', `C${SHARP}`, 'D', `D${SHARP}`, 'E', 'F', `F${SHARP}`, 'G', `G${SHARP}`, 'A', `A${SHARP}`, 'B'];
const LETTER_FLAT = ['C', `D${FLAT}`, 'D', `E${FLAT}`, 'E', 'F', `G${FLAT}`, 'G', `A${FLAT}`, 'A', `B${FLAT}`, 'B'];
// German: B♭ is "B", B is "H" in both spellings (D27); other accidentals keep the ♯/♭ symbols.
const GERMAN_SHARP = ['C', `C${SHARP}`, 'D', `D${SHARP}`, 'E', 'F', `F${SHARP}`, 'G', `G${SHARP}`, 'A', 'B', 'H'];
const GERMAN_FLAT = ['C', `D${FLAT}`, 'D', `E${FLAT}`, 'E', 'F', `G${FLAT}`, 'G', `A${FLAT}`, 'A', 'B', 'H'];
// Fixed-do solfège (Italian/Spanish spelling "Re"; D27).
const SOLFEGE_SHARP = ['Do', `Do${SHARP}`, 'Re', `Re${SHARP}`, 'Mi', 'Fa', `Fa${SHARP}`, 'Sol', `Sol${SHARP}`, 'La', `La${SHARP}`, 'Si'];
const SOLFEGE_FLAT = ['Do', `Re${FLAT}`, 'Re', `Mi${FLAT}`, 'Mi', 'Fa', `Sol${FLAT}`, 'Sol', `La${FLAT}`, 'La', `Si${FLAT}`, 'Si'];

const TABLES: Record<NoteSystem, Record<Accidental, string[]>> = {
  letter: { sharp: LETTER_SHARP, flat: LETTER_FLAT },
  german: { sharp: GERMAN_SHARP, flat: GERMAN_FLAT },
  solfege: { sharp: SOLFEGE_SHARP, flat: SOLFEGE_FLAT },
};

export type NoteName = { name: string; octave: number };

/** Name and scientific octave (A4 = MIDI 69, C4 = 60) of an integer MIDI note. */
export function noteName(midi: number, system: NoteSystem = 'letter', accidental: Accidental = 'sharp'): NoteName {
  const pc = ((midi % 12) + 12) % 12;
  return { name: TABLES[system][accidental][pc], octave: Math.floor(midi / 12) - 1 };
}

/** "E2", "B♭3", "Re♯4". */
export function formatNote(midi: number, system: NoteSystem = 'letter', accidental: Accidental = 'sharp'): string {
  const { name, octave } = noteName(midi, system, accidental);
  return `${name}${octave}`;
}

/**
 * Transposing instruments: semitones the WRITTEN note lies above the SOUNDING note (B♭ clarinet/trumpet +2, A +3,
 * G +5, F horn +7, E♭ alto sax +9). The detector is unaffected; only the display adds T.
 */
export const TRANSPOSITIONS = { C: 0, Bb: 2, A: 3, G: 5, F: 7, Eb: 9 } as const;
export type Transposition = keyof typeof TRANSPOSITIONS;

export function writtenMidi(sounding: number, t: Transposition): number {
  return sounding + TRANSPOSITIONS[t];
}

export function soundingMidi(written: number, t: Transposition): number {
  return written - TRANSPOSITIONS[t];
}

export const CAPO_MAX = 12;

/** Capo c raises every string target by c semitones. */
export function applyCapo(strings: readonly number[], capo: number): number[] {
  const c = Math.max(0, Math.min(CAPO_MAX, Math.round(capo)));
  return strings.map((m) => m + c);
}

export type A4Result = { ok: true; value: number } | { ok: false; error: 'notANumber' | 'outOfRange' };

/**
 * Parses an A4 reference ("442", "441.5", "441,5"), rounds to 0.1 Hz. Out-of-range input is rejected; use
 * `clampA4` for steppers.
 */
export function validateA4(input: string | number): A4Result {
  const n = typeof input === 'number' ? input : Number(String(input).trim().replace(',', '.'));
  if (!Number.isFinite(n) || (typeof input === 'string' && input.trim() === '')) return { ok: false, error: 'notANumber' };
  const v = Math.round(n * 10) / 10;
  if (v < A4_MIN || v > A4_MAX) return { ok: false, error: 'outOfRange' };
  return { ok: true, value: v };
}

export function clampA4(n: number): number {
  if (!Number.isFinite(n)) return A4_DEFAULT;
  return Math.min(A4_MAX, Math.max(A4_MIN, Math.round(n * 10) / 10));
}
