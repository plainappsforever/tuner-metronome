import { normalizePattern, type Pattern } from '@/engine/metronome/pattern';

import { newId } from './ids';
import { withRead, withTransaction, withWrite } from './tx';
import type { Db } from './types';

export type Preset = { id: string; name: string; pattern: Pattern; createdAt: number; updatedAt: number };
export const PRESET_NAME_MAX = 40;

type Row = { id: string; name: string; pattern: string; created_at: number; updated_at: number };

function parsePattern(text: string): Pattern {
  try {
    return normalizePattern(JSON.parse(text));
  } catch {
    return normalizePattern({}); // damaged JSON → defaults, never a crash
  }
}

const fromRow = (r: Row): Preset => ({ id: r.id, name: r.name, pattern: parsePattern(r.pattern), createdAt: r.created_at, updatedAt: r.updated_at });

export function cleanName(name: string, max = PRESET_NAME_MAX): string {
  const n = String(name ?? '').trim().slice(0, max);
  if (!n) throw new Error('name required');
  return n;
}

export async function listPresets(db: Db): Promise<Preset[]> {
  const rows = await withRead(db, (r) => r.getAllAsync<Row>('SELECT * FROM metronome_presets ORDER BY name COLLATE NOCASE, id'));
  return rows.map(fromRow);
}

export async function getPreset(db: Db, id: string): Promise<Preset | null> {
  const row = await withRead(db, (r) => r.getFirstAsync<Row>('SELECT * FROM metronome_presets WHERE id = ?', id));
  return row ? fromRow(row) : null;
}

/** Saves a new preset (no id) or overwrites one; the pattern is normalised before it is stored. */
export async function savePreset(db: Db, input: { id?: string; name: string; pattern: unknown }, now = Date.now()): Promise<Preset> {
  const name = cleanName(input.name);
  const pattern = normalizePattern(input.pattern);
  const id = input.id ?? newId(now);
  await withWrite(db, (tx) =>
    tx.runAsync(
      `INSERT INTO metronome_presets (id, name, pattern, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, pattern = excluded.pattern, updated_at = excluded.updated_at`,
      id,
      name,
      JSON.stringify(pattern),
      now,
      now
    )
  );
  return (await getPreset(db, id)) as Preset;
}

export async function renamePreset(db: Db, id: string, name: string, now = Date.now()): Promise<void> {
  const n = cleanName(name);
  await withWrite(db, (tx) => tx.runAsync('UPDATE metronome_presets SET name = ?, updated_at = ? WHERE id = ?', n, now, id));
}

export type DeletedPreset = { preset: Preset; items: { setlistId: string; position: number; autoAdvanceBars: number | null }[] };

/**
 * Deletes a preset and removes its setlist items in the same transaction, renumbering each affected setlist 0…n−1
 * (SPEC §4). Returns what was removed so the UI can undo.
 */
export async function deletePreset(db: Db, id: string, now = Date.now()): Promise<DeletedPreset | null> {
  return withTransaction(db, async (tx) => {
    const row = await tx.getFirstAsync<Row>('SELECT * FROM metronome_presets WHERE id = ?', id);
    if (!row) return null;
    const items = await tx.getAllAsync<{ setlist_id: string; position: number; auto_advance_bars: number | null }>(
      'SELECT setlist_id, position, auto_advance_bars FROM setlist_items WHERE preset_id = ? ORDER BY setlist_id, position',
      id
    );
    await tx.runAsync('DELETE FROM setlist_items WHERE preset_id = ?', id);
    await tx.runAsync('DELETE FROM metronome_presets WHERE id = ?', id);
    for (const setlistId of new Set(items.map((i) => i.setlist_id))) await renumber(tx, setlistId, now);
    return {
      preset: fromRow(row),
      items: items.map((i) => ({ setlistId: i.setlist_id, position: i.position, autoAdvanceBars: i.auto_advance_bars })),
    };
  });
}

/** Undo of deletePreset: restores the preset and re-inserts its items at their old positions. */
export async function restorePreset(db: Db, deleted: DeletedPreset, now = Date.now()): Promise<void> {
  await withTransaction(db, async (tx) => {
    const p = deleted.preset;
    await tx.runAsync(
      'INSERT OR REPLACE INTO metronome_presets (id, name, pattern, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      p.id,
      p.name,
      JSON.stringify(p.pattern),
      p.createdAt,
      p.updatedAt
    );
    for (const item of [...deleted.items].sort((a, b) => a.position - b.position)) {
      const exists = await tx.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM setlists WHERE id = ?', item.setlistId);
      if (!exists?.n) continue;
      // Shift the later items up by one (from the end, so the primary key never collides), then insert.
      const later = await tx.getAllAsync<{ position: number }>(
        'SELECT position FROM setlist_items WHERE setlist_id = ? AND position >= ? ORDER BY position DESC',
        item.setlistId,
        item.position
      );
      for (const l of later) {
        await tx.runAsync('UPDATE setlist_items SET position = ? WHERE setlist_id = ? AND position = ?', l.position + 1, item.setlistId, l.position);
      }
      await tx.runAsync(
        'INSERT INTO setlist_items (setlist_id, position, preset_id, auto_advance_bars) VALUES (?, ?, ?, ?)',
        item.setlistId,
        item.position,
        p.id,
        item.autoAdvanceBars
      );
      await renumber(tx, item.setlistId, now);
    }
  });
}

/** Renumbers a setlist's items to 0…n−1 keeping their order (call inside a write unit). */
export async function renumber(tx: Db, setlistId: string, now: number): Promise<void> {
  const rows = await tx.getAllAsync<{ position: number }>('SELECT position FROM setlist_items WHERE setlist_id = ? ORDER BY position', setlistId);
  // Two passes through negative positions so no step collides with the primary key.
  for (let i = 0; i < rows.length; i++) {
    await tx.runAsync('UPDATE setlist_items SET position = ? WHERE setlist_id = ? AND position = ?', -1 - i, setlistId, rows[i].position);
  }
  for (let i = 0; i < rows.length; i++) {
    await tx.runAsync('UPDATE setlist_items SET position = ? WHERE setlist_id = ? AND position = ?', i, setlistId, -1 - i);
  }
  await tx.runAsync('UPDATE setlists SET updated_at = ? WHERE id = ?', now, setlistId);
}
