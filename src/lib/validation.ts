export type ItemInput = { title: string; note: string };

export const TITLE_MAX = 100;
export const NOTE_MAX = 1000;

export type ValidationResult = { ok: true; value: ItemInput } | { ok: false; error: string };

export function validateItem(raw: ItemInput): ValidationResult {
  const title = raw.title.trim();
  const note = raw.note.trim();
  if (!title) return { ok: false, error: 'Please enter a title.' };
  if (title.length > TITLE_MAX) return { ok: false, error: `Title must be ${TITLE_MAX} characters or fewer.` };
  if (note.length > NOTE_MAX) return { ok: false, error: `Note must be ${NOTE_MAX} characters or fewer.` };
  return { ok: true, value: { title, note } };
}
