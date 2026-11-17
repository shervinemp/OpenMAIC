import { describe, expect, it } from 'vitest';

import type { QuizQuestion } from '@/lib/types/stage';
import type { ReviewCard } from '@/lib/learning/types';
import { cardLocation, quizAnswerSummary } from '@/lib/learning/review-presentation';

function card(overrides: Partial<ReviewCard> = {}): ReviewCard {
  return {
    cardId: 'stage-1:scene-1:q1',
    conceptIds: ['recursion'],
    ease: 2.5,
    intervalDays: 0,
    repetitions: 0,
    lapses: 0,
    dueAt: 1_000,
    ...overrides,
  };
}

function question(overrides: Partial<QuizQuestion>): QuizQuestion {
  return {
    id: 'q1',
    type: 'single',
    question: 'Question text',
    hasAnswer: true,
    ...overrides,
  } as QuizQuestion;
}

describe('review card location', () => {
  it('prefers explicit scene and item fields', () => {
    expect(cardLocation(card({ sceneId: 'scene:one', itemId: 'q 1' }))).toEqual({
      sceneId: 'scene:one',
      itemId: 'q 1',
    });
  });

  it('decodes the legacy encoded card id', () => {
    expect(cardLocation(card({ cardId: 'stage%3A1:scene%3A1:q%201' }))).toEqual({
      sceneId: 'scene:1',
      itemId: 'q 1',
    });
  });

  it('returns nothing for an unqualified id', () => {
    expect(cardLocation(card({ cardId: 'q1' }))).toEqual({});
  });
});

describe('quiz answer summary', () => {
  it('shows option labels rather than letters for choice questions', () => {
    expect(
      quizAnswerSummary(
        question({
          type: 'multiple',
          options: [
            { value: 'A', label: 'Base case' },
            { value: 'B', label: 'Bigger input' },
            { value: 'C', label: 'Smaller input' },
          ],
          answer: ['A', 'C'],
        }),
      ),
    ).toBe('Base case · Smaller input');
  });

  it('appends the unit to a numeric answer', () => {
    expect(quizAnswerSummary(question({ type: 'numeric', answer: ['0.392'], unit: 'm' }))).toBe(
      '0.392 m',
    );
  });

  it('shows the stored order and matching pairs', () => {
    expect(
      quizAnswerSummary(
        question({
          type: 'ordering',
          options: [
            { value: 'A', label: 'Ingest' },
            { value: 'B', label: 'Validate' },
            { value: 'C', label: 'Aggregate' },
          ],
        }),
      ),
    ).toBe('Ingest → Validate → Aggregate');

    expect(
      quizAnswerSummary(
        question({
          type: 'matching',
          options: [
            { value: 'A', label: 'Bronze' },
            { value: 'B', label: 'Silver' },
          ],
          matches: [
            { value: 'A', label: 'Raw events' },
            { value: 'B', label: 'Cleaned records' },
          ],
        }),
      ),
    ).toBe('Bronze → Raw events · Silver → Cleaned records');
  });

  it('has no single answer for a short-answer item', () => {
    expect(quizAnswerSummary(question({ type: 'short_answer' }))).toBe('');
  });
});
