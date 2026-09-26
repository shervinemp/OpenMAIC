import { describe, expect, it } from 'vitest';

import { gradeChoiceQuestions } from '@/lib/quiz/grading';
import { healedAnswerKey } from '@/lib/quiz/answer-key-heal';
import type { QuizQuestion } from '@/lib/types/stage';

const options = [
  { value: 'A', label: 'Completeness, because required values are absent from many rows' },
  { value: 'B', label: 'Accuracy, because stored postal codes do not match reality' },
  { value: 'C', label: 'Uniqueness, because the same customer appears twice' },
  { value: 'D', label: 'Validity, because codes do not conform to the format' },
];
const question = (patch: Partial<QuizQuestion>): QuizQuestion => ({
  id: 'q1',
  type: 'single',
  question: 'Which data quality dimension is violated here?',
  options,
  ...patch,
});

describe('healedAnswerKey', () => {
  it('resolves a truncated label that grades a correct choice as wrong', () => {
    const q = question({ answer: ['Completeness'] });
    expect(gradeChoiceQuestions([q], { q1: 'A' })[0]?.correct).toBe(false);

    const answer = healedAnswerKey(q);

    expect(answer).toEqual(['A']);
    expect(gradeChoiceQuestions([{ ...q, answer: answer! }], { q1: 'A' })[0]?.correct).toBe(true);
  });

  it('splits a multi-select key written as one string of joined labels', () => {
    const q = question({
      type: 'multiple',
      answer: [`${options[0]!.label}; ${options[2]!.label}`],
    });

    expect(healedAnswerKey(q)).toEqual(['A', 'C']);
  });

  it('canonicalizes an exact label key to its value', () => {
    expect(healedAnswerKey(question({ answer: [options[1]!.label] }))).toEqual(['B']);
  });

  it('leaves keys that already are values alone, in any order', () => {
    expect(healedAnswerKey(question({ answer: ['B'] }))).toBeNull();
    expect(healedAnswerKey(question({ type: 'multiple', answer: ['C', 'A'] }))).toBeNull();
  });

  it('never guesses', () => {
    // A fragment that is not a whole-word prefix.
    expect(healedAnswerKey(question({ answer: ['Compl'] }))).toBeNull();
    // A prefix shared by two options.
    expect(
      healedAnswerKey({
        ...question({ answer: ['Same start'] }),
        options: [
          { value: 'A', label: 'Same start, one ending' },
          { value: 'B', label: 'Same start, another ending' },
        ],
      }),
    ).toBeNull();
    // Joined labels with leftover words are not just separators.
    expect(
      healedAnswerKey(
        question({
          type: 'multiple',
          answer: [`${options[0]!.label} but not ${options[2]!.label}`],
        }),
      ),
    ).toBeNull();
    // One unresolvable key keeps the whole question as stored.
    expect(
      healedAnswerKey(question({ type: 'multiple', answer: [options[0]!.label, 'nonsense'] })),
    ).toBeNull();
  });

  it('does not touch short-answer questions', () => {
    expect(healedAnswerKey(question({ type: 'short_answer', answer: ['anything'] }))).toBeNull();
  });
});
