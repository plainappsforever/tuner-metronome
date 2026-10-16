import { newId } from './ids';
import { cleanName, renumber } from './presets';
import { withRead, withTransaction, withWrite } from './tx';
import type { Db } from './types';

export type Setlist = { id: string; name: string; createdAt: number; updatedAt: number };
export type SetlistItem = { position: number; presetId: string; autoAdvanceBars: number | null };
export const AUTO_ADVANCE_MAX = 999;

type Row = { id: string; name: string; created_at: number; updated_at: number };
const fromRow = (r: Row): Setlist => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at });

const cleanBars = (n: number | null | undefined): number | null =>
  n === null || n === undefined || !Number.isFinite(n) || n < 1 ? null : Math.min(AUTO_ADVANCE_MAX, Math.round(n));

export async function listSetlists(db: Db): Promise<Setlist[]> {
  const rows = await withRead(db, (r) => r.getAllAsync<Row>('SELECT * FROM setlists ORDER BY name COLLATE NOCASE, id'));
  return rows.map(fromRow);
}

export async function createSetlist(db: Db, name: string, now = Date.now()): Promise<Setlist> {
  const n = cleanName(name);
  const id = newId(now);
  await withWrite(db, (tx) => tx.runAsync('INSERT INTO setlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', id, n, now, now));
  return { id, name: n, createdAt: now, updatedAt: now };
}

export async function renameSetlist(db: Db, id: string, name: string, now = Date.now()): Promise<void> {
  const n = cleanName(name);
  await withWrite(db, (tx) => tx.runAsync('UPDATE setlists SET name = ?, updated_at = ? WHERE id = ?', n, now, id));
}

/** Deletes a setlist and its items in one transaction. */
export async function deleteSetlist(db: Db, id: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.runAsync('DELETE FROM setlist_items WHERE setlist_id = ?', id);
    await tx.runAsync('DELETE FROM setlists WHERE id = ?', id);
  });
}

export async function getSetlistItems(db: Db, setlistId: string): Promise<SetlistItem[]> {
  const rows = await withRead(db, (r) =>
    r.getAllAsync<{ position: number; preset_id: string; auto_advance_bars: number | null }>(
      'SELECT position, preset_id, auto_advance_bars FROM setlist_items WHERE setlist_id = ? ORDER BY position',
      setlistId
    )
  );
  return rows.map((r) => ({ position: r.position, presetId: r.preset_id, autoAdvanceBars: r.auto_advance_bars }));
}

/**
 * Replaces the whole item list (reorder by drag, add, remove) in one transaction; positions become 0…n−1 in the given
 * order. Items whose preset no longer exists are dropped.
 */
export async function setSetlistItems(
  db: Db,
  setlistId: string,
  items: { presetId: string; autoAdvanceBars?: number | null }[],
  now = Date.now()
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const exists = await tx.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM setlists WHERE id = ?', setlistId);
    if (!exists?.n) throw new Error('setlist not found');
    await tx.runAsync('DELETE FROM setlist_items WHERE setlist_id = ?', setlistId);
    let position = 0;
    for (const item of items) {
      const preset = await tx.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM metronome_presets WHERE id = ?', item.presetId);
      if (!preset?.n) continue;
      await tx.runAsync(
        'INSERT INTO setlist_items (setlist_id, position, preset_id, auto_advance_bars) VALUES (?, ?, ?, ?)',
        setlistId,
        position++,
        item.presetId,
        cleanBars(item.autoAdvanceBars)
      );
    }
    await tx.runAsync('UPDATE setlists SET updated_at = ? WHERE id = ?', now, setlistId);
  });
}

export async function addToSetlist(db: Db, setlistId: string, presetId: string, autoAdvanceBars: number | null = null, now = Date.now()): Promise<void> {
  await withTransaction(db, async (tx) => {
    const last = await tx.getFirstAsync<{ m: number | null }>('SELECT MAX(position) AS m FROM setlist_items WHERE setlist_id = ?', setlistId);
    await tx.runAsync(
      'INSERT INTO setlist_items (setlist_id, position, preset_id, auto_advance_bars) VALUES (?, ?, ?, ?)',
      setlistId,
      (last?.m ?? -1) + 1,
      presetId,
      cleanBars(autoAdvanceBars)
    );
    await tx.runAsync('UPDATE setlists SET updated_at = ? WHERE id = ?', now, setlistId);
  });
}

export async function removeFromSetlist(db: Db, setlistId: string, position: number, now = Date.now()): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.runAsync('DELETE FROM setlist_items WHERE setlist_id = ? AND position = ?', setlistId, position);
    await renumber(tx, setlistId, now);
  });
}

/** Setlist navigation: index of the next/previous item, clamped (no wrap-around). */
export function stepIndex(count: number, index: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  return Math.min(count - 1, Math.max(0, index + dir));
}
