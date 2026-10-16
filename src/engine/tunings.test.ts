import { de } from '../lib/messages/de';
import { en } from '../lib/messages/en';
import { formatNote } from './notes';
import { INSTRUMENTS, NOTE_MAX, NOTE_MIN, STRINGS_MAX, targetNotes, TUNINGS, tuningById, tuningRange } from './tunings';

const show = (id: string) => {
  const t = tuningById(id)!;
  return t.strings.map((m) => formatNote(m, 'letter', t.flats ? 'flat' : 'sharp')).join(' ');
};

describe('tunings table (SPEC §5.2)', () => {
  it('ids are unique and stable-looking; every tuning names an existing instrument', () => {
    const ids = TUNINGS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TUNINGS) {
      expect(t.id).toMatch(/^[a-zA-Z0-9]+\.[a-z0-9-]+$/);
      expect(t.id.startsWith(`${t.instrument}.`)).toBe(true);
      expect(INSTRUMENTS.some((i) => i.id === t.instrument)).toBe(true);
    }
  });

  it('every note is within C0–C8, 1–12 strings (chromatic has none), courses consistent', () => {
    for (const t of TUNINGS) {
      if (t.instrument === 'chromatic') {
        expect(t.strings).toHaveLength(0);
        continue;
      }
      expect(t.strings.length).toBeGreaterThanOrEqual(1);
      expect(t.strings.length).toBeLessThanOrEqual(STRINGS_MAX);
      for (const m of [...t.strings, ...(t.courses?.flat() ?? [])]) {
        expect(Number.isInteger(m)).toBe(true);
        expect(m).toBeGreaterThanOrEqual(NOTE_MIN);
        expect(m).toBeLessThanOrEqual(NOTE_MAX);
      }
      if (t.courses) {
        expect(t.courses).toHaveLength(t.strings.length);
        t.courses.forEach((c, i) => {
          expect(c[0]).toBe(t.strings[i]);
          for (const member of c) expect([0, 12]).toContain(member - t.strings[i]);
        });
      }
    }
  });

  it('no two tunings of one instrument have identical notes (duplicates are aliases instead)', () => {
    const seen = new Map<string, string>();
    for (const t of TUNINGS) {
      const key = `${t.instrument}:${JSON.stringify(t.courses ?? t.strings)}`;
      expect(seen.get(key)).toBeUndefined();
      seen.set(key, t.id);
    }
  });

  it('has the guitar library and every instrument family of the spec', () => {
    expect(TUNINGS.filter((t) => t.instrument === 'guitar').length).toBeGreaterThanOrEqual(30);
    for (const i of INSTRUMENTS) expect(TUNINGS.some((t) => t.instrument === i.id)).toBe(true);
  });

  it('spot checks against the cited sources (names → notes)', () => {
    expect(show('guitar.standard')).toBe('E2 A2 D3 G3 B3 E4');
    expect(show('guitar.half-step-down')).toBe('E♭2 A♭2 D♭3 G♭3 B♭3 E♭4');
    expect(show('guitar.drop-d')).toBe('D2 A2 D3 G3 B3 E4');
    expect(show('guitar.drop-b')).toBe('B1 F♯2 B2 E3 G♯3 C♯4');
    expect(show('guitar.dadgad')).toBe('D2 A2 D3 G3 A3 D4');
    expect(show('guitar.open-g')).toBe('D2 G2 D3 G3 B3 D4');
    expect(show('guitar.open-a')).toBe('E2 A2 C♯3 E3 A3 E4');
    expect(show('guitar.open-c-minor')).toBe('C2 G2 C3 G3 C4 E♭4');
    expect(show('guitar.c6')).toBe('C2 A2 C3 G3 C4 E4');
    expect(show('guitar.new-standard')).toBe('C2 G2 D3 A3 E4 G4');
    expect(show('guitar.lute')).toBe('E2 A2 D3 F♯3 B3 E4');
    expect(show('guitar.nashville')).toBe('E3 A3 D4 G4 B3 E4');
    expect(show('guitar7.b-standard')).toBe('B1 E2 A2 D3 G3 B3 E4');
    expect(show('guitar8.f-sharp-standard')).toBe('F♯1 B1 E2 A2 D3 G3 B3 E4');
    expect(show('bass5.standard')).toBe('B0 E1 A1 D2 G2');
    expect(show('ukulele.standard')).toBe('G4 C4 E4 A4');
    expect(show('banjo5.open-g')).toBe('G4 D3 G3 B3 D4');
    expect(show('violin.standard')).toBe('G3 D4 A4 E5');
    expect(show('cello.standard')).toBe('C2 G2 D3 A3');
    expect(show('doubleBass.solo')).toBe('F♯1 B1 E2 A2');
  });

  it('target notes include 12-string octave members; ranges for the low-mode decision', () => {
    expect(targetNotes(tuningById('guitar12.standard')!)).toEqual([40, 45, 50, 52, 55, 57, 59, 62, 64, 67]);
    expect(tuningRange(tuningById('bass5.standard')!)).toEqual({ low: 23, high: 43 });
    expect(tuningRange(tuningById('chromatic.chromatic')!)).toBeNull();
  });

  it('every tuning and instrument name exists in English and German', () => {
    const keys = new Set(Object.keys(en));
    for (const t of TUNINGS) expect(keys.has(t.nameKey)).toBe(true);
    for (const i of INSTRUMENTS) expect(keys.has(i.nameKey)).toBe(true);
    for (const t of TUNINGS) expect(de[t.nameKey as keyof typeof de]).toBeTruthy();
  });
});
