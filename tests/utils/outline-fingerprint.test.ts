import { describe, expect, it } from 'vitest';

import type { SceneOutline } from '@/lib/types/generation';
import { outlineFingerprint } from '@/lib/utils/outline-fingerprint';

const base: SceneOutline = {
  id: 'o1',
  type: 'slide',
  title: 'Joins',
  description: 'Explain inner and outer joins.',
  keyPoints: ['inner join', 'outer join'],
  order: 3,
  mediaGenerations: [{ type: 'image', prompt: 'a venn diagram', elementId: 'gen_img_1' }],
};

describe('outlineFingerprint', () => {
  it('ignores what moves without the lesson changing', () => {
    const same = outlineFingerprint({
      ...base,
      id: 'renamed',
      order: 9,
      title: 'A different title',
      lessonId: 'lesson_4',
      estimatedDuration: 999,
      retrievalContext: 'fresh chunks [source p.1]',
      languageNote: 'inferred again',
    });
    expect(same).toBe(outlineFingerprint(base));
  });

  it('ignores whitespace-only rewraps', () => {
    expect(
      outlineFingerprint({
        ...base,
        description: '  Explain inner\nand   outer joins. ',
        keyPoints: ['inner  join', 'outer\njoin'],
      }),
    ).toBe(outlineFingerprint(base));
  });

  it.each([
    ['description', { description: 'Explain semi joins.' }],
    ['keyPoints', { keyPoints: ['inner join'] }],
    ['teachingObjective', { teachingObjective: 'Choose the right join.' }],
    ['type', { type: 'quiz' as const }],
    [
      'media prompt',
      { mediaGenerations: [{ type: 'image' as const, prompt: 'a table', elementId: 'gen_img_1' }] },
    ],
  ])('sees a real change to %s', (_label, patch) => {
    expect(outlineFingerprint({ ...base, ...patch })).not.toBe(outlineFingerprint(base));
  });
});
