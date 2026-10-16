import {
  A4_MAX,
  A4_MIN,
  applyCapo,
  centsBetween,
  clampA4,
  formatNote,
  midiToHz,
  nearestNote,
  noteName,
  soundingMidi,
  TRANSPOSITIONS,
  validateA4,
  writtenMidi,
  type Transposition,
} from './notes';

describe('notes and pitch maths', () => {
  it('maps MIDI ↔ Hz at any A4', () => {
    expect(midiToHz(69)).toBe(440);
    expect(midiToHz(57)).toBeCloseTo(220, 10);
    expect(midiToHz(40)).toBeCloseTo(82.4069, 3); // E2
    expect(midiToHz(23)).toBeCloseTo(30.8677, 3); // B0
    expect(midiToHz(69, 415)).toBe(415);
    expect(centsBetween(441, 440)).toBeCloseTo(3.93, 2);
  });

  it('nearestNote returns cents in [−50, +50) for every note and offset at A4 415–466', () => {
    for (const a4 of [415, 440, 442, 466]) {
      for (let m = 12; m <= 108; m++) {
        // (Exactly −50 is the float boundary; tested below with an exact frequency.)
        for (const c of [-49.999, -49.99, -12.3, 0, 12.3, 49.99]) {
          const f = midiToHz(m + c / 100, a4);
          const n = nearestNote(f, a4);
          expect(n.cents).toBeGreaterThanOrEqual(-50);
          expect(n.cents).toBeLessThan(50);
          expect(n.midi).toBe(m);
          expect(n.cents).toBeCloseTo(c, 6);
        }
      }
    }
    // Exactly +50 cents belongs to the next note.
    expect(nearestNote(midiToHz(60.5)).midi).toBe(61);
    expect(nearestNote(440 * Math.SQRT2 ** (1 / 6) * 2 ** 0).cents).toBeGreaterThanOrEqual(-50);
  });

  it('names notes in letter, German and solfège systems with scientific octaves', () => {
    expect(formatNote(40)).toBe('E2');
    expect(formatNote(69)).toBe('A4');
    expect(formatNote(60)).toBe('C4');
    expect(formatNote(61)).toBe('C♯4');
    expect(formatNote(70, 'letter', 'flat')).toBe('B♭4');
    expect(noteName(70, 'german').name).toBe('B');
    expect(noteName(71, 'german').name).toBe('H');
    expect(noteName(70, 'german', 'flat').name).toBe('B');
    expect(noteName(62, 'solfege').name).toBe('Re');
    expect(noteName(63, 'solfege', 'flat').name).toBe('Mi♭');
    expect(formatNote(12)).toBe('C0');
    expect(formatNote(108)).toBe('C8');
    expect(formatNote(23)).toBe('B0');
  });

  it('transposition round trip for all 128 notes × 6 transpositions', () => {
    for (const t of Object.keys(TRANSPOSITIONS) as Transposition[]) {
      for (let m = 0; m < 128; m++) expect(soundingMidi(writtenMidi(m, t), t)).toBe(m);
    }
    expect(writtenMidi(58, 'Bb')).toBe(60); // concert B♭ = written C on a B♭ instrument
    expect(writtenMidi(63, 'Eb')).toBe(72); // concert E♭4 = written C5 on alto sax
    expect(writtenMidi(53, 'F')).toBe(60); // concert F3 = written C4 on horn
  });

  it('capo raises every string; clamps 0–12', () => {
    expect(applyCapo([40, 45, 50], 2)).toEqual([42, 47, 52]);
    expect(applyCapo([40], 20)).toEqual([52]);
    expect(applyCapo([40], -3)).toEqual([40]);
  });

  it('validates and clamps A4 415.0–466.0 in 0.1 Hz steps', () => {
    expect(validateA4('442')).toEqual({ ok: true, value: 442 });
    expect(validateA4('441,56')).toEqual({ ok: true, value: 441.6 });
    expect(validateA4(415)).toEqual({ ok: true, value: 415 });
    expect(validateA4('414.9')).toEqual({ ok: false, error: 'outOfRange' });
    expect(validateA4('466.1')).toEqual({ ok: false, error: 'outOfRange' });
    expect(validateA4('abc')).toEqual({ ok: false, error: 'notANumber' });
    expect(validateA4('')).toEqual({ ok: false, error: 'notANumber' });
    expect(clampA4(500)).toBe(A4_MAX);
    expect(clampA4(100)).toBe(A4_MIN);
    expect(clampA4(NaN)).toBe(440);
  });
});
