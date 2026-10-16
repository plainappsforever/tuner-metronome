import { MIN_SESSION_SECONDS, totals, type EndedBy, type PracticeSession, type Totals } from '@/engine/practice';

import { newId } from './ids';
import { withRead, withWrite } from './tx';
import type { Db } from './types';

type Row = {
  id: string;
  started_at: number;
  ended_at: number;
  seconds: number;
  bpm_min: number;
  bpm_max: number;
  preset_id: string | null;
  setlist_id: string | null;
  ended_by: string;
};

const ENDED: readonly EndedBy[] = ['user', 'autostop', 'interruption', 'process'];

const fromRow = (r: Row): PracticeSession => ({
  id: r.id,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  seconds: r.seconds,
  bpmMin: r.bpm_min,
  bpmMax: r.bpm_max,
  presetId: r.preset_id,
  setlistId: r.setlist_id,
  endedBy: ENDED.includes(r.ended_by as EndedBy) ? (r.ended_by as EndedBy) : 'user',
});

/** Saves a finished run if it had ≥ 20 audible seconds (SPEC §5.9); returns the id or null when not saved. */
export async function savePracticeSession(db: Db, s: Omit<PracticeSession, 'id'> & { id?: string }): Promise<string | null> {
  if (!(s.seconds >= MIN_SESSION_SECONDS)) return null;
  const id = s.id ?? newId(s.endedAt);
  await withWrite(db, (tx) =>
    tx.runAsync(
      `INSERT OR REPLACE INTO practice_sessions
       (id, started_at, ended_at, seconds, bpm_min, bpm_max, preset_id, setlist_id, ended_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      s.startedAt,
      s.endedAt,
      Math.floor(s.seconds),
      s.bpmMin,
      s.bpmMax,
      s.presetId,
      s.setlistId,
      ENDED.includes(s.endedBy) ? s.endedBy : 'user'
    )
  );
  return id;
}

export async function listPracticeSessions(db: Db, limit = 50): Promise<PracticeSession[]> {
  const rows = await withRead(db, (r) => r.getAllAsync<Row>('SELECT * FROM practice_sessions ORDER BY started_at DESC, id LIMIT ?', limit));
  return rows.map(fromRow);
}

export async function practiceTotals(db: Db, now = Date.now()): Promise<Totals> {
  const rows = await withRead(db, (r) => r.getAllAsync<{ started_at: number; seconds: number }>('SELECT started_at, seconds FROM practice_sessions'));
  return totals(
    rows.map((x) => ({ startedAt: x.started_at, seconds: x.seconds })),
    now
  );
}
