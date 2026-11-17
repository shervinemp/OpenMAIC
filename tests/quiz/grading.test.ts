import { describe, it, expect } from 'vitest';
import {
  gradeChoiceQuestions,
  isShortAnswer,
  parseNumericAnswer,
  ungradedResult,
} from '@/lib/quiz/grading';
import type { QuizQuestion } from '@/lib/types/stage';

function q(overrides: Partial<QuizQuestion>): QuizQuestion {
  return {
    id: 'q1',
    type: 'single',
    question: 'Pick one',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
    answer: ['a'],
    hasAnswer: true,
    points: 1,
    ...overrides,
  };
}

describe('gradeChoiceQuestions', () => {
  it('scores a correct single-choice answer', () => {
    const results = gradeChoiceQuestions([q({})], { q1: 'a' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ questionId: 'q1', correct: true, earned: 1 });
  });

  it('scores an incorrect single-choice answer', () => {
    const results = gradeChoiceQuestions([q({})], { q1: 'b' });
    expect(results[0]).toMatchObject({ correct: false, earned: 0 });
  });

  it('treats multi-choice order-insensitively', () => {
    const question = q({ id: 'm1', type: 'multiple', answer: ['a', 'b'] });
    const results = gradeChoiceQuestions([question], { m1: ['b', 'a'] });
    expect(results[0].correct).toBe(true);
  });

  it('scores missing answer as incorrect', () => {
    const results = gradeChoiceQuestions([q({})], {});
    expect(results[0]).toMatchObject({ correct: false, earned: 0 });
  });

  it('skips short-answer questions', () => {
    const sa = q({ id: 's1', type: 'short_answer', answer: [], hasAnswer: false });
    const results = gradeChoiceQuestions([sa], { s1: 'anything' });
    expect(results).toHaveLength(0);
  });

  it('honors custom point values', () => {
    const results = gradeChoiceQuestions([q({ points: 5 })], { q1: 'a' });
    expect(results[0].earned).toBe(5);
  });
});

describe('numeric grading', () => {
  function numeric(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
    return q({
      type: 'numeric',
      options: undefined,
      answer: ['3.14'],
      tolerance: 0.01,
      unit: 'm',
      ...overrides,
    });
  }

  it('accepts a value inside the tolerance', () => {
    const [result] = gradeChoiceQuestions([numeric()], { q1: '3.145' });
    expect(result).toMatchObject({ status: 'correct', correct: true, earned: 1 });
  });

  it('rejects a value outside the tolerance', () => {
    const [result] = gradeChoiceQuestions([numeric()], { q1: '3.2' });
    expect(result).toMatchObject({ status: 'incorrect', correct: false, earned: 0 });
  });

  it('requires an exact match when no tolerance is set', () => {
    const strict = numeric({ tolerance: undefined });
    expect(gradeChoiceQuestions([strict], { q1: '3.1401' })[0]!.correct).toBe(false);
    expect(gradeChoiceQuestions([strict], { q1: '3.14' })[0]!.correct).toBe(true);
  });

  it('accepts fractions, thousands separators, decimal commas and units', () => {
    expect(parseNumericAnswer('3/4')).toBe(0.75);
    expect(parseNumericAnswer('1,234')).toBe(1234);
    expect(parseNumericAnswer('0,392')).toBe(0.392);
    expect(parseNumericAnswer('1,5')).toBe(1.5);
    expect(parseNumericAnswer('12 cm')).toBe(12);
    expect(parseNumericAnswer('-2.5e3')).toBe(-2500);
    expect(parseNumericAnswer('no digits here')).toBeNull();
  });

  it('marks an empty answer incorrect', () => {
    const [result] = gradeChoiceQuestions([numeric()], {});
    expect(result).toMatchObject({ status: 'incorrect', earned: 0 });
  });

  it('marks a malformed answer key ungraded instead of penalizing the learner', () => {
    const [result] = gradeChoiceQuestions([numeric({ answer: ['not-a-number'] })], { q1: '3.14' });
    expect(result).toMatchObject({ status: 'ungraded', correct: null, earned: 0 });
  });

  it('does not treat an empty key as zero', () => {
    const [result] = gradeChoiceQuestions([numeric({ answer: [''] })], { q1: '0' });
    expect(result).toMatchObject({ status: 'ungraded', earned: 0 });
  });
});

describe('ordering grading', () => {
  function ordered(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
    return q({
      type: 'ordering',
      options: [
        { value: 'A', label: 'Ingest raw events' },
        { value: 'B', label: 'Validate and clean' },
        { value: 'C', label: 'Aggregate into marts' },
      ],
      answer: undefined,
      ...overrides,
    });
  }

  it('accepts the stored sequence', () => {
    const [result] = gradeChoiceQuestions([ordered()], { q1: ['A', 'B', 'C'] });
    expect(result).toMatchObject({ status: 'correct', correct: true, earned: 1 });
  });

  it('rejects a different sequence even when every item is present', () => {
    const [result] = gradeChoiceQuestions([ordered()], { q1: ['A', 'C', 'B'] });
    expect(result).toMatchObject({ status: 'incorrect', earned: 0 });
  });

  it('rejects a missing item', () => {
    const [result] = gradeChoiceQuestions([ordered()], { q1: ['A', 'B'] });
    expect(result).toMatchObject({ status: 'incorrect', earned: 0 });
  });

  it('rejects an unanswered ordering question', () => {
    const [result] = gradeChoiceQuestions([ordered()], {});
    expect(result).toMatchObject({ status: 'incorrect', earned: 0 });
  });

  it('leaves a question with fewer than two items ungraded', () => {
    const [result] = gradeChoiceQuestions(
      [ordered({ options: [{ value: 'A', label: 'Only item' }] })],
      { q1: ['A'] },
    );
    expect(result).toMatchObject({ status: 'ungraded', correct: null, earned: 0 });
  });

  it('leaves duplicate item values ungraded instead of guessing', () => {
    const [result] = gradeChoiceQuestions(
      [
        ordered({
          options: [
            { value: 'A', label: 'First' },
            { value: 'A', label: 'Second' },
          ],
        }),
      ],
      { q1: ['A', 'A'] },
    );
    expect(result).toMatchObject({ status: 'ungraded', earned: 0 });
  });
});

describe('matching grading', () => {
  function paired(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
    return q({
      type: 'matching',
      options: [
        { value: 'A', label: 'Bronze' },
        { value: 'B', label: 'Silver' },
        { value: 'C', label: 'Gold' },
      ],
      matches: [
        { value: 'A', label: 'Raw events' },
        { value: 'B', label: 'Cleaned records' },
        { value: 'C', label: 'Business aggregates' },
      ],
      answer: undefined,
      ...overrides,
    });
  }

  it('accepts every correct partner', () => {
    const [result] = gradeChoiceQuestions([paired()], { q1: ['A', 'B', 'C'] });
    expect(result).toMatchObject({ status: 'correct', correct: true, earned: 1 });
  });

  it('rejects the whole question when one pair is wrong', () => {
    const [result] = gradeChoiceQuestions([paired()], { q1: ['A', 'C', 'B'] });
    expect(result).toMatchObject({ status: 'incorrect', earned: 0 });
  });

  it('rejects an incomplete or empty submission', () => {
    expect(gradeChoiceQuestions([paired()], { q1: ['A', 'B'] })[0]!.status).toBe('incorrect');
    expect(gradeChoiceQuestions([paired()], { q1: ['A', 'B', ''] })[0]!.status).toBe('incorrect');
    expect(gradeChoiceQuestions([paired()], {})[0]!.status).toBe('incorrect');
  });

  it('leaves unequal columns ungraded', () => {
    const short = paired({ matches: [{ value: 'A', label: 'Raw events' }] });
    expect(gradeChoiceQuestions([short], { q1: ['A'] })[0]).toMatchObject({
      status: 'ungraded',
      earned: 0,
    });
  });

  it('leaves repeated right-hand labels ungraded as ambiguous', () => {
    const ambiguous = paired({
      matches: [
        { value: 'A', label: 'Same' },
        { value: 'B', label: 'Same' },
        { value: 'C', label: 'Other' },
      ],
    });
    expect(gradeChoiceQuestions([ambiguous], { q1: ['A', 'B', 'C'] })[0]).toMatchObject({
      status: 'ungraded',
      earned: 0,
    });
  });
});

describe('ungradedResult', () => {
  it('marks the question ungraded without inventing a score', () => {
    const result = ungradedResult('s1', 'en-US');
    expect(result).toMatchObject({
      questionId: 's1',
      correct: null,
      status: 'ungraded',
      earned: 0,
    });
    expect(result.aiComment).toContain('Not graded');
  });

  it('uses Chinese copy for any Chinese locale', () => {
    expect(ungradedResult('s1', 'zh-CN').aiComment).toContain('未评分');
    expect(ungradedResult('s1', 'zh-TW').aiComment).toContain('未评分');
  });
});

describe('isShortAnswer', () => {
  it('returns true for type=short_answer', () => {
    expect(isShortAnswer(q({ type: 'short_answer' }))).toBe(true);
  });

  it('classifies by type only: an unanswered choice question is still a choice question', () => {
    // hasAnswer / empty answer must NOT re-route a single/multiple question to
    // AI grading — the explicit type wins.
    expect(isShortAnswer(q({ type: 'single', hasAnswer: false, answer: [] }))).toBe(false);
    expect(isShortAnswer(q({ type: 'multiple', hasAnswer: undefined, answer: [] }))).toBe(false);
  });

  it('returns false for a regular choice question', () => {
    expect(isShortAnswer(q({}))).toBe(false);
  });
});
