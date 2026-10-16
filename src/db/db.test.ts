/**
 * @jest-environment node
 */
import { createTestDb } from '../../test/node-sqlite-db';

import { addItem, listItems } from './items';
import { LATEST_VERSION, migrate } from './migrations';
import { getThemePreference, setThemePreference } from './settings';
import { DEFAULT_PATTERN } from '@/engine/metronome/pattern';
import { DEFAULT_SETTINGS, defaultNoteNames, parseSetting, readAppSetting, readAppSettings, writeAppSetting } from './app-settings';
import { deleteCustomTuning, listCustomTunings, restoreCustomTuning, saveCustomTuning, validateCustomTuning } from './custom-tunings';
import { listPracticeSessions, practiceTotals, savePracticeSession } from './practice-sessions';
import { deletePreset, getPreset, listPresets, renamePreset, restorePreset, savePreset } from './presets';
import { addToSetlist, createSetlist, deleteSetlist, getSetlistItems, listSetlists, removeFromSetlist, setSetlistItems, stepIndex } from './setlists';
import { getTuningPrefs, markTuningUsed, setFavorite } from './tuning-prefs';

async function freshDb() {
  const db = createTestDb();
  await migrate(db);
  return db;
}

describe('migrations', () => {
  it('reaches the latest version and is safe to run again', async () => {
    const db = await freshDb();
    await migrate(db);
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(row?.user_version).toBe(LATEST_VERSION);
  });
});

describe('items', () => {
  it('saves items and lists newest first', async () => {
    const db = await freshDb();
    await addItem(db, { title: 'First', note: '' }, 1000);
    await addItem(db, { title: 'Second', note: 'details' }, 2000);

    const items = await listItems(db);
    expect(items.map((i) => i.title)).toEqual(['Second', 'First']);
    expect(items[0]).toMatchObject({ note: 'details', createdAt: 2000 });
  });
});

describe('theme preference', () => {
  it('defaults to system, persists changes, and ignores invalid stored values', async () => {
    const db = await freshDb();
    expect(await getThemePreference(db)).toBe('system');

    await setThemePreference(db, 'dark');
    expect(await getThemePreference(db)).toBe('dark');

    await db.runAsync("UPDATE settings SET value = 'purple' WHERE key = 'theme'");
    expect(await getThemePreference(db)).toBe('system');
  });
});

// ---- App schema (migration 2, SPEC §4) ----


describe('migration 2 (app schema)', () => {
  it('creates the app tables', async () => {
    const db = await freshDb();
    const tables = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['custom_tunings', 'items', 'metronome_presets', 'practice_sessions', 'settings', 'setlist_items', 'setlists', 'tuning_prefs'])
    );
    expect(LATEST_VERSION).toBe(2);
  });

  it('upgrades a version-1 database and keeps its rows', async () => {
    const db = createTestDb();
    // Exactly migration 1 of the template, then a row, then the upgrade.
    await db.execAsync(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO settings (key, value) VALUES ('theme', 'dark'); PRAGMA user_version = 1;`);
    await migrate(db);
    expect(await getThemePreference(db)).toBe('dark');
    const v = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(v?.user_version).toBe(2);
  });
});

describe('app settings', () => {
  it('defaults, round trips and rejects invalid stored values', async () => {
    const db = await freshDb();
    expect(await readAppSettings(db)).toEqual(DEFAULT_SETTINGS);
    await writeAppSetting(db, 'a4', 442.04);
    await writeAppSetting(db, 'capo', 3);
    await writeAppSetting(db, 'transpose', 'Bb');
    await writeAppSetting(db, 'hapticBeat', true);
    await writeAppSetting(db, 'noteNames', 'german');
    await writeAppSetting(db, 'metronome', { ...DEFAULT_PATTERN, bpm: 133 });
    const s = await readAppSettings(db);
    expect(s).toMatchObject({ a4: 442, capo: 3, transpose: 'Bb', hapticBeat: true, noteNames: 'german' });
    expect(s.metronome.bpm).toBe(133);
    await writeAppSetting(db, 'noteNames', null);
    expect(await readAppSetting(db, 'noteNames')).toBeNull();
    for (const [key, raw] of [
      ['a4', 'x'],
      ['capo', '13'],
      ['tolerance', '4'],
      ['metronome', '{broken'],
      ['visualOffsetMs', '301'],
      ['autoStopMin', '45'],
      ['transpose', 'H'],
      ['flash', 'strobe'],
    ] as const) {
      await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, raw);
      expect(await readAppSetting(db, key)).toEqual(DEFAULT_SETTINGS[key]);
    }
    expect(parseSetting('a4', '500')).toBe(466);
  });

  it('default note names follow the language', () => {
    expect(defaultNoteNames('de')).toBe('german');
    expect(defaultNoteNames('fr')).toBe('solfege');
    expect(defaultNoteNames('pt-BR')).toBe('solfege');
    expect(defaultNoteNames('en')).toBe('letter');
    expect(defaultNoteNames('ja')).toBe('letter');
  });
});

describe('custom tunings and tuning prefs', () => {
  it('validates 1–12 strings in C0–C8, saves, updates, deletes with undo', async () => {
    const db = await freshDb();
    expect(validateCustomTuning({ instrument: 'guitar', name: '', strings: [40] })).toEqual({ ok: false, error: 'name' });
    expect(validateCustomTuning({ instrument: 'kazoo', name: 'x', strings: [40] })).toEqual({ ok: false, error: 'instrument' });
    expect(validateCustomTuning({ instrument: 'guitar', name: 'x', strings: [] })).toEqual({ ok: false, error: 'strings' });
    expect(validateCustomTuning({ instrument: 'guitar', name: 'x', strings: Array(13).fill(40) })).toEqual({ ok: false, error: 'strings' });
    expect(validateCustomTuning({ instrument: 'guitar', name: 'x', strings: [11] })).toEqual({ ok: false, error: 'strings' });
    expect(validateCustomTuning({ instrument: 'guitar', name: 'x', strings: [40.5] })).toEqual({ ok: false, error: 'strings' });
    await expect(saveCustomTuning(db, { instrument: 'guitar', name: '', strings: [40] })).rejects.toThrow();

    const t = await saveCustomTuning(db, { instrument: 'guitar', name: ' Open D6 ', strings: [38, 45, 50, 54, 59, 62] }, 1000);
    expect(t).toMatchObject({ name: 'Open D6', createdAt: 1000, updatedAt: 1000 });
    expect(t.id.startsWith('custom.')).toBe(true);
    await saveCustomTuning(db, { id: t.id, instrument: 'guitar', name: 'Open D6 b', strings: [38, 45, 50, 54, 59, 61] }, 2000);
    const [u] = await listCustomTunings(db);
    expect(u).toMatchObject({ id: t.id, name: 'Open D6 b', createdAt: 1000, updatedAt: 2000, strings: [38, 45, 50, 54, 59, 61] });

    await setFavorite(db, t.id, true);
    const removed = await deleteCustomTuning(db, t.id);
    expect(await listCustomTunings(db)).toEqual([]);
    expect((await getTuningPrefs(db)).favorites).toEqual([]);
    await restoreCustomTuning(db, removed!);
    expect(await listCustomTunings(db)).toEqual([u]);
  });

  it('skips damaged rows instead of crashing', async () => {
    const db = await freshDb();
    await db.runAsync("INSERT INTO custom_tunings VALUES ('custom.bad', 'guitar', 'Bad', '[1,2', 1, 1)");
    await db.runAsync("INSERT INTO custom_tunings VALUES ('custom.bad2', 'guitar', 'Bad2', '[500]', 1, 1)");
    expect(await listCustomTunings(db)).toEqual([]);
  });

  it('favourites and the 5 most recent tunings', async () => {
    const db = await freshDb();
    await setFavorite(db, 'guitar.drop-d', true);
    await setFavorite(db, 'bass4.standard', true);
    await setFavorite(db, 'bass4.standard', false);
    for (let i = 0; i < 7; i++) await markTuningUsed(db, `guitar.t${i}`, 100 + i);
    await markTuningUsed(db, 'guitar.drop-d', 50);
    expect(await getTuningPrefs(db)).toEqual({
      favorites: ['guitar.drop-d'],
      recent: ['guitar.t6', 'guitar.t5', 'guitar.t4', 'guitar.t3', 'guitar.t2'],
    });
  });
});

describe('presets and setlists', () => {
  it('saves normalised patterns, renames, lists by name', async () => {
    const db = await freshDb();
    const a = await savePreset(db, { name: 'Warm-up', pattern: { bpm: 999, beats: 3 } }, 1);
    expect(a.pattern.bpm).toBe(400);
    expect(a.pattern.accents).toHaveLength(3);
    await savePreset(db, { name: 'alpha', pattern: DEFAULT_PATTERN }, 2);
    await renamePreset(db, a.id, 'Zebra', 3);
    expect((await listPresets(db)).map((p) => p.name)).toEqual(['alpha', 'Zebra']);
    await expect(savePreset(db, { name: '   ', pattern: {} })).rejects.toThrow();
    await db.runAsync("UPDATE metronome_presets SET pattern = 'nope' WHERE id = ?", a.id);
    expect((await getPreset(db, a.id))?.pattern.bpm).toBe(DEFAULT_PATTERN.bpm);
  });

  it('setlist items: add, reorder, remove, auto-advance bars clamped; deleting a preset removes its items in one transaction', async () => {
    const db = await freshDb();
    const p1 = await savePreset(db, { name: 'One', pattern: { bpm: 60 } });
    const p2 = await savePreset(db, { name: 'Two', pattern: { bpm: 90 } });
    const p3 = await savePreset(db, { name: 'Three', pattern: { bpm: 120 } });
    const s = await createSetlist(db, 'Gig');
    const t = await createSetlist(db, 'Practice');
    await addToSetlist(db, s.id, p1.id, 8);
    await addToSetlist(db, s.id, p2.id, 0);
    await addToSetlist(db, s.id, p3.id, 5000);
    await addToSetlist(db, t.id, p2.id);
    expect(await getSetlistItems(db, s.id)).toEqual([
      { position: 0, presetId: p1.id, autoAdvanceBars: 8 },
      { position: 1, presetId: p2.id, autoAdvanceBars: null },
      { position: 2, presetId: p3.id, autoAdvanceBars: 999 },
    ]);
    await setSetlistItems(db, s.id, [{ presetId: p3.id }, { presetId: 'gone' }, { presetId: p1.id, autoAdvanceBars: 4 }]);
    expect((await getSetlistItems(db, s.id)).map((i) => [i.position, i.presetId])).toEqual([
      [0, p3.id],
      [1, p1.id],
    ]);
    await addToSetlist(db, s.id, p2.id);
    await removeFromSetlist(db, s.id, 0);
    expect((await getSetlistItems(db, s.id)).map((i) => [i.position, i.presetId])).toEqual([
      [0, p1.id],
      [1, p2.id],
    ]);

    const deleted = await deletePreset(db, p2.id);
    expect(deleted?.items.map((i) => i.setlistId).sort()).toEqual([s.id, t.id].sort());
    expect((await getSetlistItems(db, s.id)).map((i) => [i.position, i.presetId])).toEqual([[0, p1.id]]);
    expect(await getSetlistItems(db, t.id)).toEqual([]);
    await restorePreset(db, deleted!);
    expect((await getSetlistItems(db, s.id)).map((i) => [i.position, i.presetId])).toEqual([
      [0, p1.id],
      [1, p2.id],
    ]);
    expect((await getSetlistItems(db, t.id)).map((i) => i.presetId)).toEqual([p2.id]);

    await deleteSetlist(db, s.id);
    expect((await listSetlists(db)).map((x) => x.name)).toEqual(['Practice']);
    expect(await getSetlistItems(db, s.id)).toEqual([]);
    await expect(setSetlistItems(db, 'missing', [])).rejects.toThrow();
  });

  it('a failing step inside deletePreset rolls back the whole delete', async () => {
    const db = await freshDb();
    const p = await savePreset(db, { name: 'One', pattern: {} });
    const s = await createSetlist(db, 'S');
    await addToSetlist(db, s.id, p.id);
    await db.execAsync("CREATE TRIGGER fail_delete BEFORE DELETE ON metronome_presets BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    await expect(deletePreset(db, p.id)).rejects.toThrow('boom');
    expect(await getSetlistItems(db, s.id)).toHaveLength(1);
    expect(await getPreset(db, p.id)).not.toBeNull();
  });

  it('setlist navigation clamps at both ends', () => {
    expect(stepIndex(3, 0, -1)).toBe(0);
    expect(stepIndex(3, 2, 1)).toBe(2);
    expect(stepIndex(3, 1, 1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });
});

describe('practice sessions', () => {
  it('saves runs ≥ 20 s only, lists newest first, totals by week', async () => {
    const db = await freshDb();
    const base = { bpmMin: 80, bpmMax: 120, presetId: null, setlistId: null, endedBy: 'user' as const };
    const mon = new Date(2026, 9, 12, 10).getTime();
    expect(await savePracticeSession(db, { ...base, startedAt: mon, endedAt: mon + 19_000, seconds: 19 })).toBeNull();
    await savePracticeSession(db, { ...base, startedAt: mon, endedAt: mon + 600_000, seconds: 600 });
    await savePracticeSession(db, { ...base, startedAt: mon - 86_400_000, endedAt: mon, seconds: 125, endedBy: 'autostop' });
    const list = await listPracticeSessions(db);
    expect(list.map((s) => s.seconds)).toEqual([600, 125]);
    expect(list[1].endedBy).toBe('autostop');
    expect(await practiceTotals(db, new Date(2026, 9, 16).getTime())).toEqual({ weekSeconds: 600, allSeconds: 725, weekMinutes: 10, allMinutes: 12 });
  });
});
