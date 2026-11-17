import { describe, expect, it } from 'vitest';
import { hasPracticeAnswer, hasQuizAnswer, summarizePractice } from '@/lib/quiz/practice';
import type { QuestionResult } from '@/lib/quiz/grading';
import type { QuizQuestion } from '@/lib/types/stage';

function result(
  questionId: string,
  status: QuestionResult['status'],
  earned: number,
): QuestionResult {
  return { questionId, status, earned, correct: status === 'correct' ? true : null };
}

describe('summarizePractice', () => {
  const points = { q1: 2, q2: 3, q3: 1 };

  it('counts outcomes and excludes ungraded questions from the total', () => {
    const summary = summarizePractice(
      [result('q1', 'correct', 2), result('q2', 'incorrect', 0), result('q3', 'ungraded', 0)],
      points,
    );
    expect(summary).toEqual({
      correct: 1,
      incorrect: 1,
      ungraded: 1,
      earned: 2,
      gradedTotal: 5,
      missed: ['q2', 'q3'],
    });
  });

  it('offers ungraded answers for another attempt without penalizing them', () => {
    const summary = summarizePractice([result('q3', 'ungraded', 0)], points);
    expect(summary.gradedTotal).toBe(0);
    expect(summary.missed).toEqual(['q3']);
  });

  it('reports no missed questions when everything is correct', () => {
    const summary = summarizePractice(
      [result('q1', 'correct', 2), result('q2', 'correct', 3)],
      points,
    );
    expect(summary.missed).toEqual([]);
    expect(summary.earned).toBe(5);
    expect(summary.gradedTotal).toBe(5);
  });

  it('defaults a missing points entry to one point', () => {
    const summary = summarizePractice([result('unknown', 'correct', 1)], points);
    expect(summary.gradedTotal).toBe(1);
  });
});

describe('hasPracticeAnswer', () => {
  it('requires a non-empty answer', () => {
    expect(hasPracticeAnswer(undefined)).toBe(false);
    expect(hasPracticeAnswer('   ')).toBe(false);
    expect(hasPracticeAnswer([])).toBe(false);
    expect(hasPracticeAnswer('42')).toBe(true);
    expect(hasPracticeAnswer(['A'])).toBe(true);
  });
});

describe('hasQuizAnswer', () => {
  const matching: QuizQuestion = {
    id: 'm1',
    type: 'matching',
    question: 'Match the layers.',
    options: [
      { value: 'A', label: 'Bronze' },
      { value: 'B', label: 'Silver' },
    ],
    matches: [
      { value: 'A', label: 'Raw' },
      { value: 'B', label: 'Clean' },
    ],
  };

  it('requires every matching pair to be chosen', () => {
    expect(hasQuizAnswer(matching, undefined)).toBe(false);
    expect(hasQuizAnswer(matching, [])).toBe(false);
    expect(hasQuizAnswer(matching, [''])).toBe(false);
    expect(hasQuizAnswer(matching, ['A'])).toBe(false);
    expect(hasQuizAnswer(matching, ['A', ''])).toBe(false);
    expect(hasQuizAnswer(matching, ['A', 'B'])).toBe(true);
  });

  it('keeps the other types at one non-empty entry', () => {
    const ordering: QuizQuestion = {
      id: 'o1',
      type: 'ordering',
      question: 'Put these in order.',
      options: [
        { value: 'A', label: 'One' },
        { value: 'B', label: 'Two' },
      ],
    };
    expect(hasQuizAnswer(ordering, ['A'])).toBe(true);
    expect(hasQuizAnswer(ordering, [])).toBe(false);
  });
});
