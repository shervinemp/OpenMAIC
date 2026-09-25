import { describe, expect, it } from 'vitest';

import { computeActionsSourceHash, stableStringify } from '@/lib/utils/content-hash';

describe('stableStringify', () => {
  it('is key-order independent', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('sorts nested keys recursively', () => {
    expect(stableStringify({ outer: { z: 1, y: { deep: 2 } } })).toBe(
      stableStringify({ outer: { y: { deep: 2 }, z: 1 } }),
    );
  });

  it('treats arrays as ordered', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});

describe('computeActionsSourceHash', () => {
  const content = { kind: 'slide', blocks: [{ text: 'Loop free. 12 words to test hashing.' }] };
  const params = {
    agents: [{ id: 'a1', name: 'Nora', role: 'professor' }],
    userProfile: 'prefers terse',
    languageDirective: 'english',
  };

  it('is deterministic for identical inputs', () => {
    expect(computeActionsSourceHash({ content, ...params })).toBe(
      computeActionsSourceHash({ content, ...params }),
    );
  });

  it('differs on any content change', () => {
    const tweaked = { ...content, blocks: [{ text: 'different' }] };
    expect(computeActionsSourceHash({ content: tweaked, ...params })).not.toBe(
      computeActionsSourceHash({ content, ...params }),
    );
  });

  it('differs when action-relevant parameters change', () => {
    expect(computeActionsSourceHash({ content, ...params, languageDirective: 'german' })).not.toBe(
      computeActionsSourceHash({ content, ...params }),
    );
    expect(
      computeActionsSourceHash({
        content,
        ...params,
        agents: [{ id: 'a2', name: 'Ken', role: 'teacher' }],
      }),
    ).not.toBe(computeActionsSourceHash({ content, ...params }));
  });

  it('is key-order independent on the content payload', () => {
    const variant = { blocks: [{ text: 'Loop free. 12 words to test hashing.' }], kind: 'slide' };
    expect(computeActionsSourceHash({ content: variant, ...params })).toBe(
      computeActionsSourceHash({ content, ...params }),
    );
  });
});
