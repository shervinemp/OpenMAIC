import { describe, expect, it } from 'vitest';

import {
  findSilentSlides,
  hasNarration,
  precedingSpeeches,
} from '@/lib/maintenance/silent-narration';
import type { Scene } from '@/lib/types/stage';

const text = (words: number) => Array.from({ length: words }, (_, i) => `word${i}`).join(' ');

function slide(id: string, order: number, words: number, speech: string[] = []): Scene {
  return {
    id,
    order,
    type: 'slide',
    title: id,
    content: {
      type: 'slide',
      canvas: { elements: [{ id: `${id}-t`, type: 'text', content: `<p>${text(words)}</p>` }] },
    },
    actions: speech.map((line, index) => ({ id: `${id}-a${index}`, type: 'speech', text: line })),
  } as unknown as Scene;
}

describe('findSilentSlides', () => {
  it('finds a substantive slide with no narration, in play order', () => {
    const scenes = [slide('b', 2, 80), slide('a', 1, 60), slide('c', 3, 90, ['Spoken.'])];
    expect(findSilentSlides(scenes).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('leaves titles and labels alone', () => {
    expect(findSilentSlides([slide('t', 1, 4), slide('edge', 2, 11)])).toEqual([]);
    expect(findSilentSlides([slide('edge', 1, 12)]).map((s) => s.id)).toEqual(['edge']);
  });

  it('only counts slides, and only real speech', () => {
    const quiz = { ...slide('q', 1, 80), type: 'quiz' } as unknown as Scene;
    const blank = slide('blank', 2, 80, ['   ']);
    expect(findSilentSlides([quiz, blank]).map((s) => s.id)).toEqual(['blank']);
    expect(hasNarration(blank)).toBe(false);
  });
});

describe('precedingSpeeches', () => {
  const scenes = [
    slide('s1', 1, 50, ['one', 'two']),
    slide('s2', 2, 50, ['three']),
    slide('s3', 3, 50),
    slide('s4', 4, 50, ['later']),
  ];

  it('returns what was said before, oldest first, never what comes after', () => {
    expect(precedingSpeeches(scenes, scenes[2]!)).toEqual(['one', 'two', 'three']);
  });

  it('keeps only the most recent lines up to the limit', () => {
    expect(precedingSpeeches(scenes, scenes[2]!, 2)).toEqual(['two', 'three']);
  });

  it('is empty at the start of the course', () => {
    expect(precedingSpeeches(scenes, scenes[0]!)).toEqual([]);
  });
});
