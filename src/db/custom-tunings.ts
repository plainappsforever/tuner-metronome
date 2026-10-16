import { INSTRUMENTS, NOTE_MAX, NOTE_MIN, STRINGS_MAX, type InstrumentId } from '@/engine/tunings';

import { newId } from './ids';
import { withRead, withWrite } from './tx';
import type { Db } from './types';

export type CustomTuning = {
  id: string;
  instrument: InstrumentId;
  name: string;
  strings: number[];
  createdAt: number;
  updatedAt: number;
};

export type CustomTuningInput = { id?: string; instrument: string; name: string; strings: unknown };
export const TUNING_NAME_MAX = 40;

type Row = { id: string; instrument: string; name: string; strings: string; created_at: number; updated_at: number };

export type TuningValidation =
  | { ok: true; value: { instrument: InstrumentId; name: string; strings: number[] } }
  | { ok: false; error: 'name' | 'instrument' | 'strings' };

/** 1–12 strings, every note an integer C0–C8 (12–108), a non-empty name ≤ 40 characters, a known instrument. */
export function validateCustomTuning(input: CustomTuningInput): TuningValidation {
  const name = String(input.name ?? '').trim();
  if (!name || name.length > TUNING_NAME_MAX) return { ok: false, error: 'name' };
  if (!INSTRUMENTS.some((i) => i.id === input.instrument) || input.instrument === 'chromatic') return { ok: false, error: 'instrument' };
  const s = input.strings;
  if (!Array.isArray(s) || s.length < 1 || s.length > STRINGS_MAX) return { ok: false, error: 'strings' };
  if (!s.every((m) => Number.isInteger(m) && m >= NOTE_MIN && m <= NOTE_MAX)) return { ok: false, error: 'strings' };
  return { ok: true, value: { instrument: input.instrument as InstrumentId, name, strings: s as number[] } };
}

function fromRow(r: Row): CustomTuning | null {
  try {
    const v = validateCustomTuning({ instrument: r.instrument, name: r.name, strings: JSON.parse(r.strings) });
    if (!v.ok) return null;
    return { id: r.id, ...v.value, createdAt: r.created_at, updatedAt: r.updated_at };
  } catch {
    return null; // a damaged row is skipped, never crashes the picker
  }
}

export async function listCustomTunings(db: Db): Promise<CustomTuning[]> {
  const rows = await withRead(db, (r) => r.getAllAsync<Row>('SELECT * FROM custom_tunings ORDER BY name COLLATE NOCASE, id'));
  return rows.map(fromRow).filter((x): x is CustomTuning => x !== null);
}

/** Inserts (no id) or updates (id) a custom tuning; returns the saved row. Throws on invalid input. */
export async function saveCustomTuning(db: Db, input: CustomTuningInput, now = Date.now()): Promise<CustomTuning> {
  const v = validateCustomTuning(input);
  if (!v.ok) throw new Error(`invalid custom tuning: ${v.error}`);
  const id = input.id ?? `custom.${newId(now)}`;
  const strings = JSON.stringify(v.value.strings);
  return withWrite(db, async (tx) => {
    await tx.runAsync(
      `INSERT INTO custom_tunings (id, instrument, name, strings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET instrument = excluded.instrument, name = excluded.name, strings = excluded.strings,
       updated_at = excluded.updated_at`,
      id,
      v.value.instrument,
      v.value.name,
      strings,
      now,
      now
    );
    const row = await tx.getFirstAsync<Row>('SELECT * FROM custom_tunings WHERE id = ?', id);
    return fromRow(row as Row) as CustomTuning;
  });
}

/** Deletes a custom tuning (and its favourite/recent entry); returns the row for undo, or null. */
export async function deleteCustomTuning(db: Db, id: string): Promise<CustomTuning | null> {
  return withWrite(db, async (tx) => {
    const row = await tx.getFirstAsync<Row>('SELECT * FROM custom_tunings WHERE id = ?', id);
    await tx.runAsync('DELETE FROM custom_tunings WHERE id = ?', id);
    await tx.runAsync('DELETE FROM tuning_prefs WHERE tuning_id = ?', id);
    return row ? fromRow(row) : null;
  });
}

/** Undo of a delete: puts the row back exactly. */
export async function restoreCustomTuning(db: Db, t: CustomTuning): Promise<void> {
  await withWrite(db, (tx) =>
    tx.runAsync(
      'INSERT OR REPLACE INTO custom_tunings (id, instrument, name, strings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      t.id,
      t.instrument,
      t.name,
      JSON.stringify(t.strings),
      t.createdAt,
      t.updatedAt
    )
  );
}
