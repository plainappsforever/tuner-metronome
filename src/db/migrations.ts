import { withTransaction } from './tx';
import type { Db } from './types';

// Append-only. Never edit a migration that has shipped; add a new one instead.
const MIGRATIONS: string[] = [
  `CREATE TABLE items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   );
   CREATE TABLE settings (
     key TEXT PRIMARY KEY NOT NULL,
     value TEXT NOT NULL
   );`,
  // 2 — app schema (SPEC §4, 2026-10-16). No audio is ever stored. Pattern JSON is versioned (`v: 1`).
  `CREATE TABLE custom_tunings (
     id TEXT PRIMARY KEY NOT NULL,
     instrument TEXT NOT NULL,
     name TEXT NOT NULL,
     strings TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE tuning_prefs (
     tuning_id TEXT PRIMARY KEY NOT NULL,
     favorite INTEGER NOT NULL DEFAULT 0,
     last_used_at INTEGER
   );
   CREATE TABLE metronome_presets (
     id TEXT PRIMARY KEY NOT NULL,
     name TEXT NOT NULL,
     pattern TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE setlists (
     id TEXT PRIMARY KEY NOT NULL,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE setlist_items (
     setlist_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     preset_id TEXT NOT NULL,
     auto_advance_bars INTEGER,
     PRIMARY KEY (setlist_id, position)
   );
   CREATE INDEX setlist_items_preset ON setlist_items (preset_id);
   CREATE TABLE practice_sessions (
     id TEXT PRIMARY KEY NOT NULL,
     started_at INTEGER NOT NULL,
     ended_at INTEGER NOT NULL,
     seconds INTEGER NOT NULL,
     bpm_min INTEGER NOT NULL,
     bpm_max INTEGER NOT NULL,
     preset_id TEXT,
     setlist_id TEXT,
     ended_by TEXT NOT NULL
   );
   CREATE INDEX practice_sessions_started ON practice_sessions (started_at);`,
];

export const LATEST_VERSION = MIGRATIONS.length;

export async function migrate(db: Db, migrations: string[] = MIGRATIONS): Promise<void> {
  // The version is read INSIDE each unit: another JS handle on the same connection (e.g. a background task at a cold
  // start) may have migrated meanwhile, and a migration must never run twice. One transaction per migration: a
  // failure rolls back both the schema change and user_version.
  for (;;) {
    const applied = await withTransaction(db, async (tx) => {
      const row = await tx.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      const version = row?.user_version ?? 0;
      if (version >= migrations.length) return false;
      await tx.execAsync(`${migrations[version]} PRAGMA user_version = ${version + 1};`);
      return true;
    });
    if (!applied) return;
  }
}
