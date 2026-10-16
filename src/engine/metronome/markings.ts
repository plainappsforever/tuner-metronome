// Tempo markings (SPEC §5.7). Ranges follow the spec table, which matches the common modern metronome ranges listed in
// Wikipedia "Tempo" § "Basic tempo markings" (https://en.wikipedia.org/wiki/Tempo#Basic_tempo_markings, 2026-10-16);
// sources disagree by a few BPM at every border — these are conventions, not rules. Names stay Italian in every
// language (i18n keys `marking.<id>`). Tapping a marking sets `set`: the middle of its range; for the open-ended
// ends Grave 30 and Prestissimo 208 (the classic Maelzel maximum) instead of a middle of 10–39 / 200–400.

export type Marking = { id: string; lo: number; hi: number; set: number };

export const MARKINGS: readonly Marking[] = [
  { id: 'grave', lo: 10, hi: 39, set: 30 },
  { id: 'largo', lo: 40, hi: 59, set: 50 },
  { id: 'larghetto', lo: 60, hi: 65, set: 63 },
  { id: 'adagio', lo: 66, hi: 75, set: 71 },
  { id: 'andante', lo: 76, hi: 107, set: 92 },
  { id: 'moderato', lo: 108, hi: 119, set: 114 },
  { id: 'allegro', lo: 120, hi: 155, set: 138 },
  { id: 'vivace', lo: 156, hi: 175, set: 166 },
  { id: 'presto', lo: 176, hi: 199, set: 188 },
  { id: 'prestissimo', lo: 200, hi: 400, set: 208 },
];

export function markingFor(bpm: number): Marking {
  const b = Math.round(bpm);
  return MARKINGS.find((m) => b >= m.lo && b <= m.hi) ?? (b < 10 ? MARKINGS[0] : MARKINGS[MARKINGS.length - 1]);
}
