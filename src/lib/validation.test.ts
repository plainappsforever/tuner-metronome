import { NOTE_MAX, TITLE_MAX, validateItem } from './validation';

describe('validateItem', () => {
  it('trims and accepts a valid item', () => {
    expect(validateItem({ title: '  Buy milk ', note: ' 2 litres ' })).toEqual({
      ok: true,
      value: { title: 'Buy milk', note: '2 litres' },
    });
  });

  it('requires a title', () => {
    expect(validateItem({ title: '   ', note: 'x' })).toEqual({ ok: false, error: 'Please enter a title.' });
  });

  it('enforces length limits', () => {
    expect(validateItem({ title: 'a'.repeat(TITLE_MAX + 1), note: '' }).ok).toBe(false);
    expect(validateItem({ title: 'ok', note: 'a'.repeat(NOTE_MAX + 1) }).ok).toBe(false);
  });
});
