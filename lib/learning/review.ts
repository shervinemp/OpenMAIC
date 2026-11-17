/**
 * A compact SM-2 review scheduler.
 *
 * SM-2 is the right first scheduler for this platform: state is three numbers
 * per card (ease, interval, repetitions), every rating has a documented
 * effect, and the behaviour is easy to audit against a learner's history. A
 * full FSRS fit needs a corpus of real reviews; the rating interface here is
 * deliberately scheduler-agnostic, so replacing the arithmetic later does not
 * change callers or stored ratings.
 *
 * Time is passed in. The scheduler never reads the wall clock, which lets tests
 * pin exact due dates and lets a server rebuild a queue deterministically.
 *
 * `again` is short-term relearning, not a day-scale interval: the card is due
 * again in ten minutes, because a lapse should be repaired in the same sitting
 * rather than postponed to tomorrow.
 */

import type { LearningEvidence, ReviewCard, ReviewRating } from './types';

export const REVIEW_DAY_MS = 24 * 60 * 60 * 1000;
export const RELEARN_DELAY_MS = 10 * 60 * 1000;
export const DEFAULT_REVIEW_EASE = 2.5;
export const MIN_REVIEW_EASE = 1.3;

/**
 * SM-2 quality, mapped from the four ratings a learner can actually choose.
 * `hard` still counts as a pass: it strengthens the memory, but it lowers ease
 * because the recall was effortful.
 */
const QUALITY: Record<ReviewRating, number> = {
  again: 2,
  hard: 3,
  good: 4,
  easy: 5,
};

function nextEase(ease: number, quality: number): number {
  const current = Number.isFinite(ease) ? Math.max(MIN_REVIEW_EASE, ease) : DEFAULT_REVIEW_EASE;
  // SM-2 writes this as `0.1 - (5-q) * (0.08 + (5-q) * 0.02)`. Keeping the
  // `5-q` form makes the sign obvious: a worse rating subtracts more.
  const miss = 5 - quality;
  const updated = current + (0.1 - miss * (0.08 + miss * 0.02));
  return Math.max(MIN_REVIEW_EASE, updated);
}

function nextIntervalDays(card: ReviewCard, repetitions: number): number {
  if (repetitions <= 1) return 1;
  if (repetitions === 2) return 6;
  const growth = Number.isFinite(card.intervalDays) ? Math.max(1, card.intervalDays) : 1;
  const ease = Number.isFinite(card.ease)
    ? Math.max(MIN_REVIEW_EASE, card.ease)
    : DEFAULT_REVIEW_EASE;
  return Math.max(1, Math.round(growth * ease));
}

/** A card that has never been reviewed and is due immediately. */
export function newReviewCard(
  cardId: string,
  conceptIds: readonly string[],
  now: number,
): ReviewCard {
  return {
    cardId,
    conceptIds: [...new Set(conceptIds)],
    ease: DEFAULT_REVIEW_EASE,
    intervalDays: 0,
    repetitions: 0,
    lapses: 0,
    dueAt: now,
  };
}

/** Keep one card from claiming an unbounded set of concepts. */
const MAX_CARD_CONCEPTS = 16;

/**
 * Normalize one untrusted stored card, or return `null` when it carries no
 * usable schedule. A corrupt card must be dropped, not repaired into a bogus
 * due date: the review queue is the one place where a wrong timestamp would
 * actively mislead the learner.
 */
export function normalizeReviewCard(value: unknown): ReviewCard | null {
  if (!value || typeof value !== 'object') return null;
  const card = value as Partial<ReviewCard>;

  const cardId = typeof card.cardId === 'string' ? card.cardId.trim() : '';
  if (!cardId) return null;

  const numbers = [card.ease, card.intervalDays, card.repetitions, card.lapses, card.dueAt];
  if (numbers.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    return null;
  }
  if ((card.dueAt as number) < 0) return null;

  const conceptIds: string[] = [];
  if (Array.isArray(card.conceptIds)) {
    for (const entry of card.conceptIds) {
      if (typeof entry !== 'string') continue;
      const conceptId = entry.trim();
      if (!conceptId || conceptIds.includes(conceptId)) continue;
      conceptIds.push(conceptId);
      if (conceptIds.length >= MAX_CARD_CONCEPTS) break;
    }
  }

  const lastReviewedAt = card.lastReviewedAt;
  const sceneId = typeof card.sceneId === 'string' ? card.sceneId.trim() : '';
  const itemId = typeof card.itemId === 'string' ? card.itemId.trim() : '';
  return {
    cardId,
    conceptIds,
    ...(sceneId ? { sceneId } : {}),
    ...(itemId ? { itemId } : {}),
    ease: Math.max(MIN_REVIEW_EASE, card.ease as number),
    intervalDays: Math.max(0, Math.round(card.intervalDays as number)),
    repetitions: Math.max(0, Math.floor(card.repetitions as number)),
    lapses: Math.max(0, Math.floor(card.lapses as number)),
    dueAt: card.dueAt as number,
    ...(typeof lastReviewedAt === 'number' && Number.isFinite(lastReviewedAt) && lastReviewedAt >= 0
      ? { lastReviewedAt }
      : {}),
  };
}

/**
 * Apply one rating. The interval grows using the ease the card had going into
 * the review; the rating then adjusts ease for the next interval. A lapse
 * (`again` on a card that had been learned) increments `lapses` and resets the
 * repetition count, while `again` on a brand-new card is simply "not learned
 * yet" and is not counted as a lapse.
 */
export function reviewCard(card: ReviewCard, rating: ReviewRating, now: number): ReviewCard {
  const quality = QUALITY[rating];
  const ease = nextEase(card.ease, quality);

  if (quality < 3) {
    return {
      ...card,
      ease,
      intervalDays: 0,
      repetitions: 0,
      lapses: card.lapses + (card.repetitions > 0 ? 1 : 0),
      dueAt: now + RELEARN_DELAY_MS,
      lastReviewedAt: now,
    };
  }

  const repetitions = card.repetitions + 1;
  const intervalDays = nextIntervalDays(card, repetitions);
  return {
    ...card,
    ease,
    intervalDays,
    repetitions,
    dueAt: now + intervalDays * REVIEW_DAY_MS,
    lastReviewedAt: now,
  };
}

function compareCards(a: ReviewCard, b: ReviewCard): number {
  if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
  return a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0;
}

function normalizedLimit(limit: number | undefined): number {
  if (limit === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(limit)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(limit));
}

/**
 * Cards due at `now`, earliest first. A malformed due date is never due: a
 * corrupt card must not jump the queue ahead of a real one.
 */
export function dueReviewCards(
  cards: readonly ReviewCard[],
  now: number,
  limit?: number,
): ReviewCard[] {
  return cards
    .filter((card) => Number.isFinite(card.dueAt) && card.dueAt <= now)
    .sort(compareCards)
    .slice(0, normalizedLimit(limit));
}

export interface ReviewSummary {
  total: number;
  due: number;
  /** Cards never reviewed and never lapsed. */
  newCards: number;
  /** Earliest future due date, or null when nothing is scheduled ahead. */
  nextDueAt: number | null;
}

/** Queue shape for a dashboard: how much is due now and when the next batch lands. */
export function reviewSummary(cards: readonly ReviewCard[], now: number): ReviewSummary {
  let due = 0;
  let newCards = 0;
  let nextDueAt: number | null = null;

  for (const card of cards) {
    if (Number.isFinite(card.dueAt) && card.dueAt <= now) due += 1;
    if (card.repetitions === 0 && card.lapses === 0) newCards += 1;
    if (Number.isFinite(card.dueAt) && card.dueAt > now) {
      nextDueAt = nextDueAt === null ? card.dueAt : Math.min(nextDueAt, card.dueAt);
    }
  }

  return { total: cards.length, due, newCards, nextDueAt };
}

export interface ReviewEvidenceInput {
  id: string;
  learnerKey: string;
  stageId: string;
  card: ReviewCard;
  rating: ReviewRating;
  recordedAt: number;
}

/**
 * A review result as mastery evidence.
 *
 * Self-rating is weaker than a graded item, so it carries half weight: a
 * learner who presses "easy" has told us something, but not as much as one who
 * answered a fresh question correctly. `hard` is partial credit rather than a
 * failure, because the recall did succeed.
 */
export function evidenceFromReview(input: ReviewEvidenceInput): LearningEvidence {
  const score = input.rating === 'again' ? 0 : input.rating === 'hard' ? 0.5 : 1;
  return {
    id: input.id,
    learnerKey: input.learnerKey,
    stageId: input.stageId,
    itemId: input.card.cardId,
    conceptIds: input.card.conceptIds,
    source: 'review',
    score,
    outcome: 'graded',
    recordedAt: input.recordedAt,
    weight: 0.5,
  };
}
