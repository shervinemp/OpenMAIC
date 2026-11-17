import { describe, expect, it } from 'vitest';

import { evidenceFromExamAttempt, type ExamEvidenceVariant } from '@/lib/learning/from-exam';
import type { ExamAttempt } from '@/lib/types/exam';

const attempt: ExamAttempt = {
  id: 'attempt-1',
  kind: 'midterm',
  specGeneratedAt: 100,
  mcAnswers: { mc1: 'A' },
  frAnswers: { fr1: 'an answer', fr2: '' },
  mcResults: {
    mc1: { correct: true, earned: 2 },
    mc2: { correct: false, earned: 0 },
  },
  frGrades: [{ questionId: 'fr1', score: 3, maxPoints: 6, comment: '' }],
  scorePct: 0.5,
  submittedAt: 1_000,
  gradedAt: 1_100,
};

const variant: ExamEvidenceVariant = {
  mcQuestions: [
    {
      id: 'mc1',
      question: 'Which one?',
      options: [],
      answer: ['A'],
      analysis: '',
      points: 2,
      concepts: ['Recursion', 'recursion.', 'quiz'],
    },
    {
      id: 'mc2',
      question: 'Which other one?',
      options: [],
      answer: ['B'],
      analysis: '',
      points: 1,
      concepts: ['Base Case'],
    },
  ],
  frQuestions: [
    {
      id: 'fr1',
      prompt: 'Explain the call stack',
      rubric: [],
      sampleAnswer: '',
      maxPoints: 6,
      concepts: ['Call Stack'],
    },
    {
      id: 'fr2',
      prompt: 'Explain loops',
      rubric: [],
      sampleAnswer: '',
      maxPoints: 4,
      concepts: ['Loops'],
    },
  ],
};

function records() {
  return evidenceFromExamAttempt({
    learnerKey: 'learner-1',
    stageId: 'stage-1',
    attempt,
    variant,
    recordedAt: 1_234,
  });
}

describe('exam evidence', () => {
  it('maps MC and FR results with partial credit and normalized concepts', () => {
    const evidence = records();

    expect(evidence).toHaveLength(4);
    expect(evidence[0]).toMatchObject({
      id: 'stage-1:exam:midterm:attempt-1:mc:mc1',
      itemId: 'mc1',
      conceptIds: ['recursion'],
      source: 'exam',
      score: 1,
      outcome: 'graded',
      recordedAt: 1_234,
    });
    expect(evidence[1]).toMatchObject({
      id: 'stage-1:exam:midterm:attempt-1:mc:mc2',
      conceptIds: ['base case'],
      score: 0,
      outcome: 'graded',
    });
    expect(evidence[2]).toMatchObject({
      id: 'stage-1:exam:midterm:attempt-1:fr:fr1',
      conceptIds: ['call stack'],
      score: 0.5,
      outcome: 'graded',
    });
  });

  it('keeps a missing grade ungraded instead of inventing a zero', () => {
    const evidence = records();
    expect(evidence[3]).toMatchObject({
      id: 'stage-1:exam:midterm:attempt-1:fr:fr2',
      conceptIds: ['loops'],
      score: 0,
      outcome: 'ungraded',
    });
  });

  it('clamps out-of-range scores and treats malformed points as ungraded', () => {
    const evidence = evidenceFromExamAttempt({
      learnerKey: 'learner-1',
      stageId: 'stage-1',
      attempt: {
        ...attempt,
        mcResults: { mc1: { correct: true, earned: 99 } },
        frGrades: [{ questionId: 'fr1', score: 99, maxPoints: 6, comment: '' }],
      },
      variant: {
        mcQuestions: [
          { ...variant.mcQuestions[0]!, points: 2 },
          // A zero-point item has no usable denominator.
          { ...variant.mcQuestions[1]!, points: 0 },
        ],
        frQuestions: [variant.frQuestions[0]!],
      },
      recordedAt: 1_234,
    });

    expect(evidence[0]).toMatchObject({ score: 1, outcome: 'graded' });
    expect(evidence[1]).toMatchObject({ score: 0, outcome: 'ungraded' });
    expect(evidence[2]).toMatchObject({ score: 1, outcome: 'graded' });
  });

  it('ignores stored results for questions that are not on the drawn form', () => {
    const evidence = evidenceFromExamAttempt({
      learnerKey: 'learner-1',
      stageId: 'stage-1',
      attempt,
      variant: {
        mcQuestions: [variant.mcQuestions[0]!],
        frQuestions: [],
      },
      recordedAt: 1_234,
    });

    expect(evidence.map((record) => record.itemId)).toEqual(['mc1']);
  });
});
