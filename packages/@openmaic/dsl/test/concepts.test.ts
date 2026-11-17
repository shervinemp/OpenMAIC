import { describe, expect, test } from 'vitest';

import { MAX_CONCEPT_TAGS, normalizeConceptTag, normalizeConceptTags } from '../src/concepts.js';

describe('concept tags', () => {
  test('canonicalizes list markers, quotes, trailing punctuation, and case', () => {
    expect(normalizeConceptTag('  Recursion. ')).toBe('recursion');
    expect(normalizeConceptTag('1. Base   Case')).toBe('base case');
    expect(normalizeConceptTag('- "Dynamic Programming";')).toBe('dynamic programming');
    expect(normalizeConceptTag('“Memoization”')).toBe('memoization');
  });

  test('normalizes full-width characters without mangling CJK tags', () => {
    expect(normalizeConceptTag('ＳＱＬ')).toBe('sql');
    expect(normalizeConceptTag('递归')).toBe('递归');
  });

  test('rejects values that cannot name an idea', () => {
    expect(normalizeConceptTag(42)).toBeNull();
    expect(normalizeConceptTag('')).toBeNull();
    expect(normalizeConceptTag('a')).toBeNull();
    expect(normalizeConceptTag('1234')).toBeNull();
    expect(normalizeConceptTag('...')).toBeNull();
    expect(normalizeConceptTag('multiple choice')).toBeNull();
    expect(normalizeConceptTag('Quiz')).toBeNull();
    expect(normalizeConceptTag('x'.repeat(65))).toBeNull();
  });

  test('dedupes case-insensitively, preserving the first spelling, and caps the list', () => {
    expect(normalizeConceptTags(['Recursion', 'recursion.', 'Base Case'])).toEqual([
      'recursion',
      'base case',
    ]);

    const tags = normalizeConceptTags(
      Array.from({ length: MAX_CONCEPT_TAGS + 3 }, (_, index) => `concept ${index}`),
    );
    expect(tags).toHaveLength(MAX_CONCEPT_TAGS);
    expect(tags?.[0]).toBe('concept 0');
  });

  test('returns undefined when nothing usable remains', () => {
    expect(normalizeConceptTags(undefined)).toBeUndefined();
    expect(normalizeConceptTags('recursion')).toBeUndefined();
    expect(normalizeConceptTags([])).toBeUndefined();
    expect(normalizeConceptTags([null, 'quiz', 7, ''])).toBeUndefined();
  });
});
