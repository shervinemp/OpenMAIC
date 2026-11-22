/**
 * Deterministic cross-scene redundancy check.
 *
 * Worked examples and derivations are where courses quietly repeat themselves:
 * two scenes "teach" the same calculation with a different noun. This runs on
 * the parsed outlines, before any scene generation, so a duplicate costs one
 * extra outline call instead of a full scene's worth of tokens.
 *
 * It never drops a scene. On the last attempt the outlines are accepted with a
 * warning (fail-open), exactly like the other quality signals.
 */

import type { SceneOutline } from './outline-types.js';

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'from',
  'by',
  'at',
  'as',
  'is',
  'are',
  'be',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'into',
  'out',
  'how',
  'what',
  'why',
  'when',
  'which',
  'you',
  'your',
  'we',
  'our',
  'lesson',
  'scene',
  'example',
  'worked',
  'step',
  'part',
]);

function tokens(outline: SceneOutline): Set<string> {
  const text = [outline.title ?? '', outline.description ?? '', ...(outline.keyPoints ?? [])]
    .join(' ')
    .toLowerCase();
  return new Set(
    text.split(/[^a-z0-9°µ]+/i).filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

export interface RedundantOutlinePair {
  first: string;
  second: string;
  /** Fraction of the smaller outline's vocabulary shared with the other. */
  overlap: number;
  shared: string[];
}

/**
 * Find pairs whose teaching content is nearly the same. The threshold is
 * deliberately conservative: unrelated scenes in one unit naturally share
 * a handful of domain words.
 */
export function findRedundantOutlinePairs(
  outlines: readonly SceneOutline[],
  threshold = 0.6,
): RedundantOutlinePair[] {
  const vocabularies = outlines.map(tokens);
  const pairs: RedundantOutlinePair[] = [];
  for (let i = 0; i < outlines.length; i += 1) {
    for (let j = i + 1; j < outlines.length; j += 1) {
      const a = vocabularies[i];
      const b = vocabularies[j];
      if (a.size < 4 || b.size < 4) continue;
      const shared = [...a].filter((word) => b.has(word));
      if (shared.length < 5) continue;
      const overlap = shared.length / Math.min(a.size, b.size);
      if (overlap < threshold) continue;
      pairs.push({
        first: outlines[i].id || outlines[i].title || `scene ${i + 1}`,
        second: outlines[j].id || outlines[j].title || `scene ${j + 1}`,
        overlap: Number(overlap.toFixed(2)),
        shared: shared.slice(0, 8),
      });
    }
  }
  return pairs;
}

export function summarizeRedundantOutlines(pairs: readonly RedundantOutlinePair[]): string {
  return [
    'Several planned scenes teach substantially the same content. Differentiate them by changing the context, dataset, or boundary case — do not repeat the same worked example or derivation under a new title.',
    ...pairs.map(
      (pair) =>
        `- ${pair.first} and ${pair.second} overlap ${Math.round(pair.overlap * 100)}% (shared: ${pair.shared.join(', ')})`,
    ),
  ].join('\n');
}
