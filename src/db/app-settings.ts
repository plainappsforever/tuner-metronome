// Typed app settings on the template's `settings` key/value table (SPEC §4). Every read validates and falls back to
// the default, so a damaged or foreign value never reaches the UI or the engines.
import { normalizePattern, DEFAULT_PATTERN, type Pattern } from '@/engine/metronome/pattern';
import { A4_DEFAULT, clampA4, TRANSPOSITIONS, type NoteSystem, type Transposition } from '@/engine/notes';
import { DEFAULT_TUNING_ID } from '@/engine/tunings';

import { getSetting, setSetting } from './settings';
import { withRead, withWrite } from './tx';
import type { Db } from './types';

export type AppSettings = {
  a4: number;
  noteNames: NoteSystem | null; // null = default for the UI language
  tolerance: 1 | 2 | 3 | 5;
  tunerView: 'needle' | 'strobe';
  preciseCents: boolean;
  lastTuning: string;
  capo: number;
  transpose: Transposition;
  metronome: Pattern;
  hapticBeat: boolean;
  flash: 'off' | 'dots' | 'full';
  visualOffsetMs: number;
  autoStopMin: 0 | 30 | 60 | 120 | 240;
  mixWithOthers: boolean;
  keepScreenOn: boolean;
  lastTab: 'tuner' | 'metronome';
};

export const DEFAULT_SETTINGS: AppSettings = {
  a4: A4_DEFAULT,
  noteNames: null,
  tolerance: 3,
  tunerView: 'needle',
  preciseCents: false,
  lastTuning: DEFAULT_TUNING_ID,
  capo: 0,
  transpose: 'C',
  metronome: DEFAULT_PATTERN,
  hapticBeat: false,
  flash: 'dots',
  visualOffsetMs: 0,
  autoStopMin: 120,
  mixWithOthers: true,
  keepScreenOn: false,
  lastTab: 'tuner',
};

/** Device-specific keys a backup does not carry (SPEC §4). */
export const DEVICE_ONLY_KEYS: readonly (keyof AppSettings)[] = ['visualOffsetMs'];

const oneOf = <T extends string | number>(v: T, allowed: readonly T[], d: T): T => (allowed.includes(v) ? v : d);
const bool = (s: string, d: boolean) => (s === '1' ? true : s === '0' ? false : d);
const int = (s: string) => (/^-?\d+$/.test(s) ? Number(s) : NaN);

/** Parses one stored text value; returns the default for anything invalid. */
export function parseSetting<K extends keyof AppSettings>(key: K, raw: string | null): AppSettings[K] {
  const d = DEFAULT_SETTINGS[key];
  if (raw === null) return d;
  let v: unknown;
  switch (key) {
    case 'a4': {
      const n = Number(raw);
      v = Number.isFinite(n) ? clampA4(n) : d;
      break;
    }
    case 'noteNames':
      v = oneOf(raw as NoteSystem, ['letter', 'german', 'solfege'], d as NoteSystem);
      break;
    case 'tolerance':
      v = oneOf(int(raw) as 1, [1, 2, 3, 5], d as 1);
      break;
    case 'tunerView':
      v = oneOf(raw as 'needle', ['needle', 'strobe'], 'needle');
      break;
    case 'capo': {
      const n = int(raw);
      v = n >= 0 && n <= 12 ? n : d;
      break;
    }
    case 'transpose':
      v = raw in TRANSPOSITIONS ? raw : d;
      break;
    case 'lastTuning':
      v = raw.length > 0 && raw.length <= 80 ? raw : d;
      break;
    case 'metronome':
      try {
        v = normalizePattern(JSON.parse(raw));
      } catch {
        v = d;
      }
      break;
    case 'flash':
      v = oneOf(raw as 'dots', ['off', 'dots', 'full'], 'dots');
      break;
    case 'visualOffsetMs': {
      const n = int(raw);
      v = n >= -300 && n <= 300 ? n : d;
      break;
    }
    case 'autoStopMin':
      v = oneOf(int(raw) as 0, [0, 30, 60, 120, 240], d as 0);
      break;
    case 'lastTab':
      v = oneOf(raw as 'tuner', ['tuner', 'metronome'], 'tuner');
      break;
    case 'preciseCents':
    case 'hapticBeat':
    case 'mixWithOthers':
    case 'keepScreenOn':
      v = bool(raw, d as boolean);
      break;
    default:
      v = d;
  }
  return v as AppSettings[K];
}

export function serializeSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): string | null {
  if (key === 'noteNames' && value === null) return null;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (key === 'metronome') return JSON.stringify(normalizePattern(value));
  return String(value);
}

export async function readAppSettings(db: Db): Promise<AppSettings> {
  const rows = await withRead(db, (r) => r.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM settings'));
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) out[key] = parseSetting(key, map.get(key) ?? null);
  return out as AppSettings;
}

/** Writes one setting after validating it (invalid values are stored as the parsed-back default). */
export async function writeAppSetting<K extends keyof AppSettings>(db: Db, key: K, value: AppSettings[K]): Promise<void> {
  const text = serializeSetting(key, value);
  if (text === null) {
    await withWrite(db, (tx) => tx.runAsync('DELETE FROM settings WHERE key = ?', key));
    return;
  }
  const checked = serializeSetting(key, parseSetting(key, text)) as string;
  await setSetting(db, key, checked);
}

export async function readAppSetting<K extends keyof AppSettings>(db: Db, key: K): Promise<AppSettings[K]> {
  return parseSetting(key, await getSetting(db, key));
}

/** Default note-name system by UI language (SPEC §11): de → German (H); Romance languages, ru, tr → solfège. */
export function defaultNoteNames(language: string): NoteSystem {
  if (language === 'de') return 'german';
  if (['fr', 'es', 'it', 'pt-BR', 'pt', 'ru', 'tr'].includes(language)) return 'solfege';
  return 'letter';
}
