import { de } from './messages/de';
import { en } from './messages/en';
import { getLanguage, LANGUAGES, makeT, messages, setLanguage, subscribeLanguage, translate } from './i18n';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  afterEach(() => setLanguage('en'));

  it('returns a different translator function per language (React Compiler memoises on identity)', () => {
    const enT = makeT('en');
    const deT = makeT('de');
    expect(deT).not.toBe(enT);
    expect(makeT('en')).toBe(enT);
    expect(enT('tab.tuner')).toBe('Tuner');
    expect(deT('tab.tuner')).toBe('Stimmgerät');
  });

  it('switching the language notifies subscribers and yields a new translator', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeLanguage(() => seen.push(makeT(getLanguage())('tab.metronome')));
    const before = makeT(getLanguage());
    setLanguage('de');
    setLanguage('de'); // no change, no notification
    unsubscribe();
    setLanguage('en');
    expect(seen).toEqual(['Metronom']);
    expect(makeT('de')).not.toBe(before);
  });

  it('interpolates params and leaves unknown placeholders', () => {
    expect(translate('en', 'tuner.status.idle')).toBe('Play a string');
    expect('{n} x {m}'.replace(/\{(\w+)\}/g, (m, name: string) => (name === 'n' ? '3' : m))).toBe('3 x {m}');
  });
});

describe('language parity (EN + DE)', () => {
  it('has exactly the same keys in every language', () => {
    for (const lang of LANGUAGES) expect(Object.keys(messages[lang]).sort()).toEqual(Object.keys(en).sort());
  });

  it('has no empty string and the same {placeholders} as English', () => {
    const problems: string[] = [];
    for (const lang of LANGUAGES) {
      for (const [key, text] of Object.entries(messages[lang]) as [keyof typeof en, string][]) {
        if (!text.trim()) problems.push(`${lang} ${key}: empty`);
        if (placeholders(text).join() !== placeholders(en[key]).join()) problems.push(`${lang} ${key}: placeholders`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('German is really translated (not a copy of English) for most strings', () => {
    const keys = Object.keys(en) as (keyof typeof en)[];
    const same = keys.filter((k) => de[k] === en[k]);
    // Proper names (app name, Italian tempo markings, note names, tuning names like "DADGAD") may equal English.
    expect(same.length / keys.length).toBeLessThan(0.5);
  });
});
