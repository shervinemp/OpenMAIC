import { describe, expect, it } from 'vitest';

import { applyEvidenceToConcept, emptyMastery } from '@/lib/learning/mastery';
import { planLearningRoute, type RouteLesson } from '@/lib/learning/route';
import type { ConceptMastery } from '@/lib/learning/types';

function concept(conceptId: string, scores: readonly number[]): ConceptMastery {
  return scores.reduce<ConceptMastery>(
    (state, score, index) =>
      applyEvidenceToConcept(state, {
        id: `${conceptId}:${index}`,
        learnerKey: 'learner-1',
        stageId: 'stage-1',
        itemId: `${conceptId}:${index}`,
        conceptIds: [conceptId],
        source: 'quiz',
        score,
        outcome: 'graded',
        recordedAt: index,
      }),
    emptyMastery(conceptId),
  );
}

function mastery(entries: Record<string, readonly number[]>): Record<string, ConceptMastery> {
  return Object.fromEntries(
    Object.entries(entries).map(([conceptId, scores]) => [conceptId, concept(conceptId, scores)]),
  );
}

function lesson(sceneId: string, order: number, conceptIds: string[]): RouteLesson {
  return { sceneId, title: `Lesson ${sceneId}`, order, conceptIds };
}

describe('learning route', () => {
  it('abstains when no lesson carries concept tags', () => {
    expect(planLearningRoute({ lessons: [], mastery: {} })).toEqual({
      kind: 'abstain',
      reason: 'no-tagged-lessons',
    });
    expect(
      planLearningRoute({
        lessons: [lesson('lesson-1', 0, [])],
        mastery: mastery({ a: [1, 1, 1] }),
      }),
    ).toEqual({ kind: 'abstain', reason: 'no-tagged-lessons' });
  });

  it('abstains when no graded concept evidence exists', () => {
    expect(planLearningRoute({ lessons: [lesson('lesson-1', 0, ['a'])], mastery: {} })).toEqual({
      kind: 'abstain',
      reason: 'insufficient-evidence',
    });
  });

  it('recommends the earliest weak lesson and names only its weak concepts', () => {
    const route = planLearningRoute({
      lessons: [
        lesson('lesson-1', 0, ['known']),
        lesson('lesson-2', 1, ['weak', 'fine']),
        lesson('lesson-3', 2, ['also-weak']),
      ],
      mastery: mastery({
        known: [1, 1, 1],
        weak: [1, 0],
        fine: [1, 1],
        'also-weak': [0, 0],
      }),
    });

    expect(route).toEqual({
      kind: 'review',
      lesson: lesson('lesson-2', 1, ['weak', 'fine']),
      conceptIds: ['weak'],
    });
  });

  it('starts after the leading lessons whose concepts are all known', () => {
    const route = planLearningRoute({
      lessons: [
        lesson('lesson-1', 0, ['a']),
        lesson('lesson-2', 1, ['b', 'c']),
        lesson('lesson-3', 2, ['d']),
      ],
      mastery: mastery({
        a: [1, 1, 1],
        b: [1, 1, 1],
        c: [1, 1, 1],
        d: [1],
      }),
    });

    expect(route).toEqual({
      kind: 'start',
      lesson: lesson('lesson-3', 2, ['d']),
      skipped: [lesson('lesson-1', 0, ['a']), lesson('lesson-2', 1, ['b', 'c'])],
    });
  });

  it('abstains when the first lesson is not proven known', () => {
    const route = planLearningRoute({
      lessons: [lesson('lesson-1', 0, ['a']), lesson('lesson-2', 1, ['b'])],
      mastery: mastery({ a: [1], b: [1, 1, 1] }),
    });

    expect(route).toEqual({ kind: 'abstain', reason: 'insufficient-evidence' });
  });

  it('does not skip a lesson when one of its concepts lacks enough observations', () => {
    const route = planLearningRoute({
      lessons: [lesson('lesson-1', 0, ['a', 'b'])],
      mastery: mastery({ a: [1, 1, 1], b: [1, 1] }),
    });

    expect(route).toEqual({ kind: 'abstain', reason: 'insufficient-evidence' });
  });

  it('abstains when every tagged lesson is known', () => {
    expect(
      planLearningRoute({
        lessons: [lesson('lesson-1', 0, ['a']), lesson('lesson-2', 1, ['b'])],
        mastery: mastery({ a: [1, 1, 1], b: [1, 1, 1] }),
      }),
    ).toEqual({ kind: 'abstain', reason: 'all-known' });
  });

  it('needs two observations before calling a concept weak', () => {
    expect(
      planLearningRoute({
        lessons: [lesson('lesson-1', 0, ['a'])],
        mastery: mastery({ a: [0] }),
      }),
    ).toEqual({ kind: 'abstain', reason: 'insufficient-evidence' });

    expect(
      planLearningRoute({
        lessons: [lesson('lesson-1', 0, ['a'])],
        mastery: mastery({ a: [0, 0] }),
      }),
    ).toEqual({
      kind: 'review',
      lesson: lesson('lesson-1', 0, ['a']),
      conceptIds: ['a'],
    });
  });

  it('sorts lessons by course order before deciding', () => {
    const route = planLearningRoute({
      lessons: [
        lesson('lesson-3', 2, ['c']),
        lesson('lesson-1', 0, ['a']),
        lesson('lesson-2', 1, ['b']),
      ],
      mastery: mastery({ a: [1, 1, 1], b: [1, 1, 1], c: [1] }),
    });

    expect(route).toEqual({
      kind: 'start',
      lesson: lesson('lesson-3', 2, ['c']),
      skipped: [lesson('lesson-1', 0, ['a']), lesson('lesson-2', 1, ['b'])],
    });
  });

  it('does not duplicate a weak concept repeated in the lesson', () => {
    const route = planLearningRoute({
      lessons: [lesson('lesson-1', 0, ['a', 'a'])],
      mastery: mastery({ a: [0, 0] }),
    });

    expect(route).toEqual({
      kind: 'review',
      lesson: lesson('lesson-1', 0, ['a', 'a']),
      conceptIds: ['a'],
    });
  });
});
