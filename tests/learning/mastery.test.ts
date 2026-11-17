import { describe, expect, it } from 'vitest';

import {
  applyEvidenceToConcept,
  emptyMastery,
  masteryByConcept,
  masteryConfidence,
  masteryScore,
} from '@/lib/learning/mastery';
import type { LearningEvidence } from '@/lib/learning/types';

function evidence(overrides: Partial<LearningEvidence> = {}): LearningEvidence {
  return {
    id: 'evt_1',
    learnerKey: 'learner-1',
    stageId: 'stage-1',
    itemId: 'q1',
    conceptIds: ['recursion'],
    source: 'quiz',
    score: 1,
    outcome: 'graded',
    recordedAt: 1_000,
    ...overrides,
  };
}

describe('concept mastery', () => {
  it('starts neutral with no confidence', () => {
    const state = emptyMastery('recursion');
    expect(masteryScore(state)).toBe(0.5);
    expect(masteryConfidence(state)).toBe(0);
    expect(state.evidenceCount).toBe(0);
    expect(state.lastUpdatedAt).toBeNull();
  });

  it('moves toward the evidence but keeps early uncertainty visible', () => {
    const correct = applyEvidenceToConcept(emptyMastery('recursion'), evidence());
    expect(masteryScore(correct)).toBeCloseTo(2 / 3);
    expect(masteryConfidence(correct)).toBeCloseTo(1 / 3);
    expect(correct.evidenceCount).toBe(1);
    expect(correct.lastUpdatedAt).toBe(1_000);

    const wrong = applyEvidenceToConcept(
      emptyMastery('recursion'),
      evidence({ score: 0, recordedAt: 2_000 }),
    );
    expect(masteryScore(wrong)).toBeCloseTo(1 / 3);
    expect(wrong.lastUpdatedAt).toBe(2_000);
  });

  it('treats partial credit as evidence without pretending the concept is known', () => {
    const partial = applyEvidenceToConcept(emptyMastery('recursion'), evidence({ score: 0.5 }));
    expect(masteryScore(partial)).toBeCloseTo(0.5);
    expect(masteryConfidence(partial)).toBeCloseTo(0.25);
    expect(partial.evidenceCount).toBe(1);
  });

  it('ignores ungraded evidence rather than counting it wrong', () => {
    const state = emptyMastery('recursion');
    const next = applyEvidenceToConcept(
      state,
      evidence({ outcome: 'ungraded', score: 0, recordedAt: 3_000 }),
    );
    expect(next).toBe(state);
  });

  it('ignores a non-finite score instead of corrupting the posterior', () => {
    const state = emptyMastery('recursion');
    expect(applyEvidenceToConcept(state, evidence({ score: Number.NaN }))).toBe(state);
  });

  it('caps a single record at four observations of weight', () => {
    const weighted = applyEvidenceToConcept(emptyMastery('recursion'), evidence({ weight: 9 }));
    expect(weighted.alpha).toBe(5);
    expect(weighted.beta).toBe(1);
    expect(weighted.evidenceCount).toBe(1);
  });

  it('folds untagged and ungraded records out of a batch', () => {
    const mastery = masteryByConcept([
      evidence({ id: 'a', conceptIds: ['recursion', 'memoization', 'recursion'] }),
      evidence({ id: 'b', outcome: 'ungraded', conceptIds: ['recursion'] }),
      evidence({ id: 'c', conceptIds: [] }),
      evidence({ id: 'd', conceptIds: ['memoization'], score: 0 }),
    ]);

    expect(Object.keys(mastery).sort()).toEqual(['memoization', 'recursion']);
    expect(mastery.recursion.evidenceCount).toBe(1);
    expect(mastery.memoization.evidenceCount).toBe(2);
    expect(masteryScore(mastery.memoization)).toBeCloseTo(0.5);
  });

  it('degrades a malformed posterior to the prior mean and no confidence', () => {
    const broken = { ...emptyMastery('recursion'), alpha: Number.NaN };
    expect(masteryScore(broken)).toBe(0.5);
    expect(masteryConfidence(broken)).toBe(0);
  });
});
