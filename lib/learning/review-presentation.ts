/**
 * Read-only presentation helpers for a review card.
 *
 * The dashboard can only show an item it can find in the current course. A
 * card written by an older build has no `sceneId` / `itemId`, so the encoded
 * card id is the fallback. Keeping that decoding here, next to the answer
 * summary, keeps the overlay free of persistence details.
 */

import type { QuizQuestion } from '@/lib/types/stage';
import type { ReviewCard } from './types';

export interface CardLocation {
  sceneId?: string;
  itemId?: string;
}

function decode(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Resolve the scene and item a card points at. New cards carry the fields
 * directly; legacy cards encode them as
 * `encodeURIComponent(stageId):encodeURIComponent(sceneId):encodeURIComponent(itemId)`.
 * A malformed encoding falls back to the raw segment rather than dropping the
 * card, because the comparison is exact-match against known scene ids.
 */
export function cardLocation(card: ReviewCard): CardLocation {
  if (card.sceneId && card.itemId) return { sceneId: card.sceneId, itemId: card.itemId };
  const segments = card.cardId.split(':');
  if (segments.length < 3) return {};
  return {
    sceneId: decode(segments[segments.length - 2]),
    itemId: decode(segments[segments.length - 1]),
  };
}

/**
 * Human-readable correct answer for the reveal panel.
 *
 * Choice questions show option labels, not letters, so the learner sees the
 * content they were choosing between. Ordering shows the stored correct order;
 * matching shows each aligned pair. A short-answer item has no single key, so
 * its reference explanation is the answer and this returns an empty string.
 */
export function quizAnswerSummary(question: QuizQuestion): string {
  const options = question.options ?? [];
  const labels = new Map(options.map((option) => [option.value, option.label]));

  switch (question.type) {
    case 'single':
    case 'multiple':
      return (question.answer ?? [])
        .map((value) => labels.get(value) ?? value)
        .filter(Boolean)
        .join(' · ');
    case 'numeric': {
      const value = (question.answer ?? []).join(', ');
      if (!value) return '';
      return question.unit ? `${value} ${question.unit}` : value;
    }
    case 'ordering':
      return options.map((option) => option.label).join(' → ');
    case 'matching':
      return options
        .map((option, index) => {
          const match = question.matches?.[index];
          return match ? `${option.label} → ${match.label}` : option.label;
        })
        .join(' · ');
    default:
      return '';
  }
}
