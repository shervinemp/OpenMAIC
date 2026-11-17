import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REVIEW_EASE,
  MIN_REVIEW_EASE,
  RELEARN_DELAY_MS,
  REVIEW_DAY_MS,
  dueReviewCards,
  evidenceFromReview,
  newReviewCard,
  reviewCard,
  reviewSummary,
} from '@/lib/learning/review';

const now = 1_000_000;

describe('review scheduling', () => {
  it('starts a new card due immediately', () => {
    const card = newReviewCard('card-1', ['recursion', 'recursion'], now);
    expect(card).toMatchObject({
      cardId: 'card-1',
      ease: DEFAULT_REVIEW_EASE,
      intervalDays: 0,
      repetitions: 0,
      lapses: 0,
      dueAt: now,
    });
    expect(card.conceptIds).toEqual(['recursion']);
    expect(reviewSummary([card], now)).toEqual({
      total: 1,
      due: 1,
      newCards: 1,
      nextDueAt: null,
    });
  });

  it('grows the interval 1, 6, then ease-scaled days on good reviews', () => {
    let card = newReviewCard('card-1', ['recursion'], now);
    card = reviewCard(card, 'good', now);
    expect(card).toMatchObject({ repetitions: 1, intervalDays: 1, ease: 2.5 });
    expect(card.dueAt).toBe(now + REVIEW_DAY_MS);

    const secondReview = now + REVIEW_DAY_MS;
    card = reviewCard(card, 'good', secondReview);
    expect(card).toMatchObject({ repetitions: 2, intervalDays: 6 });

    const thirdReview = secondReview + 6 * REVIEW_DAY_MS;
    card = reviewCard(card, 'good', thirdReview);
    expect(card).toMatchObject({ repetitions: 3, intervalDays: 15 });

    const fourthReview = thirdReview + 15 * REVIEW_DAY_MS;
    card = reviewCard(card, 'good', fourthReview);
    expect(card).toMatchObject({ repetitions: 4, intervalDays: 38 });
  });

  it('sends a lapse back to short-term relearning and counts it', () => {
    let card = newReviewCard('card-1', ['recursion'], now);
    card = reviewCard(card, 'good', now);
    card = reviewCard(card, 'again', now + REVIEW_DAY_MS);

    expect(card).toMatchObject({
      repetitions: 0,
      intervalDays: 0,
      lapses: 1,
    });
    expect(card.ease).toBeCloseTo(2.18);
    expect(card.dueAt).toBe(now + REVIEW_DAY_MS + RELEARN_DELAY_MS);
  });

  it('does not count pressing again on a brand-new card as a lapse', () => {
    const card = reviewCard(newReviewCard('card-1', ['recursion'], now), 'again', now);
    expect(card.lapses).toBe(0);
    expect(card.repetitions).toBe(0);
    expect(card.dueAt).toBe(now + RELEARN_DELAY_MS);
  });

  it('lets hard lower ease and easy raise it, with a floor', () => {
    const hard = reviewCard(newReviewCard('card-1', ['recursion'], now), 'hard', now);
    expect(hard.ease).toBeCloseTo(2.36);
    expect(hard.intervalDays).toBe(1);

    const easy = reviewCard(newReviewCard('card-2', ['recursion'], now), 'easy', now);
    expect(easy.ease).toBeCloseTo(2.6);

    let floor = { ...newReviewCard('card-3', ['recursion'], now), ease: MIN_REVIEW_EASE };
    for (let index = 0; index < 5; index += 1) {
      floor = reviewCard(floor, 'again', now + index * RELEARN_DELAY_MS);
    }
    expect(floor.ease).toBe(MIN_REVIEW_EASE);
  });

  it('returns due cards earliest first and respects a daily cap', () => {
    const cards = [
      newReviewCard('late', [], 300),
      newReviewCard('early', [], 100),
      newReviewCard('middle', [], 200),
      newReviewCard('future', [], 500),
    ];
    expect(dueReviewCards(cards, 300).map((card) => card.cardId)).toEqual([
      'early',
      'middle',
      'late',
    ]);
    expect(dueReviewCards(cards, 300, 2).map((card) => card.cardId)).toEqual(['early', 'middle']);
    expect(dueReviewCards(cards, 300, 0)).toEqual([]);
  });

  it('never treats a malformed due date as due', () => {
    const broken = { ...newReviewCard('broken', [], now), dueAt: Number.NaN };
    expect(dueReviewCards([broken], now)).toEqual([]);
    expect(reviewSummary([broken], now).due).toBe(0);
  });

  it('reports the next future batch separately from what is due now', () => {
    const learned = (dueAt: number) => ({
      ...newReviewCard('card', [], dueAt),
      repetitions: 1,
    });
    const summary = reviewSummary([learned(50), learned(400), learned(300)], 100);
    expect(summary).toEqual({ total: 3, due: 1, newCards: 0, nextDueAt: 300 });
  });

  it('turns a review rating into half-weight mastery evidence', () => {
    const card = newReviewCard('stage-1:q1', ['recursion'], now);
    const evidence = evidenceFromReview({
      id: 'review-1',
      learnerKey: 'learner-1',
      stageId: 'stage-1',
      card,
      rating: 'hard',
      recordedAt: now,
    });

    expect(evidence).toMatchObject({
      id: 'review-1',
      itemId: 'stage-1:q1',
      conceptIds: ['recursion'],
      source: 'review',
      outcome: 'graded',
      score: 0.5,
      weight: 0.5,
    });

    expect(
      evidenceFromReview({
        id: 'review-2',
        learnerKey: 'learner-1',
        stageId: 'stage-1',
        card,
        rating: 'again',
        recordedAt: now,
      }).score,
    ).toBe(0);
    expect(
      evidenceFromReview({
        id: 'review-3',
        learnerKey: 'learner-1',
        stageId: 'stage-1',
        card,
        rating: 'easy',
        recordedAt: now,
      }).score,
    ).toBe(1);
  });
});
