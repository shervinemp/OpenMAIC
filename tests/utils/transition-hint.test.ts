import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@/lib/types/generation';
import {
  buildParallelTransitionHints,
  deriveTransitionHint,
} from '@/lib/hooks/use-scene-generator';

const outline = (id: string, description: string): SceneOutline =>
  ({ id, description, type: 'slide', title: id, keyPoints: [], order: 1 }) as SceneOutline;

describe('deriveTransitionHint', () => {
  it('returns an empty hint for an outline with no description', () => {
    expect(deriveTransitionHint(outline('o1', ''))).toEqual([]);
  });

  it('collapses whitespace and keeps a single concise hint', () => {
    const hint = deriveTransitionHint(outline('o1', '  Frame   the\nproblem of\n scale  '));
    expect(hint).toEqual(['Frame the problem of scale']);
  });

  it('trims to the last 150 chars, matching the prompt renderer', () => {
    const long = 'x'.repeat(200) + 'END';
    expect(deriveTransitionHint(outline('o1', long))).toEqual([long.slice(-150)]);
  });
});

describe('buildParallelTransitionHints', () => {
  it('keeps the real previous speech for the first pending scene', () => {
    const pending = [outline('o1', 'first description'), outline('o2', 'second description')];
    const hints = buildParallelTransitionHints(pending, ['A real spoken line.']);
    expect(hints.get('o1')).toEqual(['A real spoken line.']);
  });

  it('derives each later hint from the preceding outline, breaking the chain', () => {
    const pending = [outline('o1', 'first description'), outline('o2', 'second description')];
    const hints = buildParallelTransitionHints(pending, ['A real spoken line.']);
    expect(hints.get('o2')).toEqual(['first description']);
  });

  it('covers every pending outline exactly once', () => {
    const pending = [outline('o1', 'a'), outline('o2', 'b'), outline('o3', 'c')];
    const hints = buildParallelTransitionHints(pending, []);
    expect([...hints.keys()]).toEqual(['o1', 'o2', 'o3']);
    expect(hints.get('o3')).toEqual(['b']);
  });
});
