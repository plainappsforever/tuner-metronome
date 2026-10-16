import type { ItemInput } from '@/lib/validation';

import { withRead, withWrite } from './tx';
import type { Db } from './types';

export type Item = {
  id: number;
  title: string;
  note: string;
  createdAt: number;
};

type ItemRow = { id: number; title: string; note: string; created_at: number };

export async function listItems(db: Db): Promise<Item[]> {
  const rows = await withRead(db, (r) =>
    r.getAllAsync<ItemRow>('SELECT id, title, note, created_at FROM items ORDER BY created_at DESC, id DESC')
  );
  return rows.map((row) => ({ id: row.id, title: row.title, note: row.note, createdAt: row.created_at }));
}

export async function addItem(db: Db, input: ItemInput, now = Date.now()): Promise<number> {
  return withWrite(db, async (tx) => {
    const result = await tx.runAsync(
      'INSERT INTO items (title, note, created_at) VALUES (?, ?, ?)',
      input.title,
      input.note,
      now
    );
    return result.lastInsertRowId;
  });
}
