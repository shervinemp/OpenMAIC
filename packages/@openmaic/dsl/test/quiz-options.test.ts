import { describe, expect, test } from 'vitest';

import { MAX_OPTION_NOTE_LENGTH, normalizeOptionNote } from '../src/quiz-options.js';

describe('option notes', () => {
  test('trims list markers, wrapping quotes, and whitespace', () => {
    expect(normalizeOptionNote('  - "Reversing cause and effect."  ')).toBe(
      'Reversing cause and effect.',
    );
    expect(normalizeOptionNote('1. Applies the rule to one case only')).toBe(
      'Applies the rule to one case only',
    );
  });

  test('rejects non-strings and empty notes', () => {
    expect(normalizeOptionNote(7)).toBeUndefined();
    expect(normalizeOptionNote('')).toBeUndefined();
    expect(normalizeOptionNote('   ')).toBeUndefined();
    expect(normalizeOptionNote('"')).toBeUndefined();
  });

  test('bounds a runaway note instead of dropping it', () => {
    const note = normalizeOptionNote('x'.repeat(MAX_OPTION_NOTE_LENGTH + 50));
    expect(note).toHaveLength(MAX_OPTION_NOTE_LENGTH);
  });
});
