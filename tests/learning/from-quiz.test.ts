import { describe, expect, it } from 'vitest';

import { evidenceFromQuizAttempt } from '@/lib/learning/from-quiz';
import type { QuestionResult } from '@/lib/quiz/grading';

function result(overrides: Partial<QuestionResult> = {}): QuestionResult {
  return {
    questionId: 'q1',
    correct: true,
    status: 'correct',
    earned: 10,
    ...overrides,
  };
}

describe('quiz evidence adapter', () => {
  it('maps each known result to one idempotent record', () => {
    const evidence = evidenceFromQuizAttempt({
      learnerKey: 'learner-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      attemptId: 'attempt-1',
      recordedAt: 5_000,
      items: [{ questionId: 'q1', conceptIds: ['recursion'] }],
      results: [result()],
    });

    expect(evidence).toEqual([
      {
        id: 'stage-1:quiz:scene-1:attempt-1:q1',
        learnerKey: 'learner-1',
        stageId: 'stage-1',
        itemId: 'q1',
        conceptIds: ['recursion'],
        source: 'quiz',
        score: 1,
        outcome: 'graded',
        recordedAt: 5_000,
      },
    ]);
  });

  it('preserves partial short-answer credit from earned points', () => {
    const evidence = evidenceFromQuizAttempt({
      learnerKey: 'learner-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      attemptId: 'attempt-1',
      recordedAt: 5_000,
      items: [
        { questionId: 'q1', points: 10 },
        { questionId: 'q2', points: 5 },
      ],
      results: [
        result({ earned: 6, status: 'incorrect', correct: false }),
        result({ questionId: 'q2', earned: 2, status: 'incorrect', correct: false }),
      ],
    });

    expect(evidence.map((record) => record.score)).toEqual([0.6, 0.4]);
  });

  it('falls back to status when points are unknown and clamps malformed credit', () => {
    const evidence = evidenceFromQuizAttempt({
      learnerKey: 'learner-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      attemptId: 'attempt-1',
      recordedAt: 5_000,
      items: [
        { questionId: 'q1' },
        { questionId: 'q2' },
        { questionId: 'q3', points: 10 },
        { questionId: 'q4', points: 10 },
      ],
      results: [
        result(),
        result({ questionId: 'q2', status: 'incorrect', correct: false, earned: 0 }),
        result({ questionId: 'q3', earned: -4 }),
        result({ questionId: 'q4', earned: 99 }),
      ],
    });

    expect(evidence.map((record) => record.score)).toEqual([1, 0, 0, 1]);
  });

  it('keeps an ungraded result as evidence without a score', () => {
    const [record] = evidenceFromQuizAttempt({
      learnerKey: 'learner-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      attemptId: 'attempt-1',
      recordedAt: 5_000,
      items: [{ questionId: 'q1', conceptIds: ['recursion'] }],
      results: [
        result({
          correct: null,
          status: 'ungraded',
          earned: 0,
        }),
      ],
    });

    expect(record).toMatchObject({ outcome: 'ungraded', score: 0 });
  });

  it('skips a result whose question is no longer in the course', () => {
    const evidence = evidenceFromQuizAttempt({
      learnerKey: 'learner-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      attemptId: 'attempt-1',
      recordedAt: 5_000,
      items: [{ questionId: 'q1' }],
      results: [result(), result({ questionId: 'removed' })],
    });

    expect(evidence.map((record) => record.itemId)).toEqual(['q1']);
  });

  it('leaves an untagged item untagged rather than inventing a concept', () => {
    const [record] = evidenceFromQuizAttempt({
      learnerKey: 'learner-1',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      attemptId: 'attempt-1',
      recordedAt: 5_000,
      items: [{ questionId: 'q1' }],
      results: [result()],
    });

    expect(record.conceptIds).toEqual([]);
  });
});
