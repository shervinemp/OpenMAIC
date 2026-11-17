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
