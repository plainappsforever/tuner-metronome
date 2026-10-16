import { withRead, withWrite } from './tx';
import type { Db } from './types';

export type TuningPrefs = { favorites: string[]; recent: string[] };
export const RECENT_MAX = 5;

/** Favourites (alphabetical by id) and the most recently used tunings (newest first, ≤ 5). */
export async function getTuningPrefs(db: Db): Promise<TuningPrefs> {
  return withRead(db, async (r) => {
    const fav = await r.getAllAsync<{ tuning_id: string }>('SELECT tuning_id FROM tuning_prefs WHERE favorite = 1 ORDER BY tuning_id');
    const recent = await r.getAllAsync<{ tuning_id: string }>(
      'SELECT tuning_id FROM tuning_prefs WHERE last_used_at IS NOT NULL ORDER BY last_used_at DESC, tuning_id LIMIT ?',
      RECENT_MAX
    );
    return { favorites: fav.map((x) => x.tuning_id), recent: recent.map((x) => x.tuning_id) };
  });
}

export async function setFavorite(db: Db, tuningId: string, favorite: boolean): Promise<void> {
  await withWrite(db, (tx) =>
    tx.runAsync(
      `INSERT INTO tuning_prefs (tuning_id, favorite) VALUES (?, ?)
       ON CONFLICT(tuning_id) DO UPDATE SET favorite = excluded.favorite`,
      tuningId,
      favorite ? 1 : 0
    )
  );
}

export async function markTuningUsed(db: Db, tuningId: string, now = Date.now()): Promise<void> {
  await withWrite(db, (tx) =>
    tx.runAsync(
      `INSERT INTO tuning_prefs (tuning_id, favorite, last_used_at) VALUES (?, 0, ?)
       ON CONFLICT(tuning_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
      tuningId,
      now
    )
  );
}
