// Translation layer. Strings live in src/lib/messages/<lang>.ts; screens call `useT()` (src/hooks/use-t.ts).
// V1 ships EN + DE from P0; the other 13 SPEC §11 languages arrive in P9 (L11 row in docs/CURRENT.md).
import { de } from './messages/de';
import { en, type MessageKey } from './messages/en';

export type { MessageKey };

export const messages: Record<'en' | 'de', Record<MessageKey, string>> = { en, de };

export type Language = keyof typeof messages;
export const LANGUAGES = Object.keys(messages) as Language[];
export type Translator = (key: MessageKey, params?: Record<string, string | number>) => string;

export const DEFAULT_LANGUAGE: Language = 'en';

let current: Language = DEFAULT_LANGUAGE;
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return current;
}

export function setLanguage(language: Language): void {
  if (language === current) return;
  current = language;
  listeners.forEach((l) => l());
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function translate(language: Language, key: MessageKey, params?: Record<string, string | number>): string {
  const text: string = messages[language][key] ?? messages[DEFAULT_LANGUAGE][key];
  return params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : text;
}

const translators = new Map<Language, Translator>();

/** One translator per language: same identity for the same language, a different function for another one. */
export function makeT(language: Language): Translator {
  let t = translators.get(language);
  if (!t) {
    t = (key, params) => translate(language, key, params);
    translators.set(language, t);
  }
  return t;
}
