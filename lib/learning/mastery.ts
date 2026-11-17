/**
 * Concept mastery from graded evidence.
 *
 * Mastery is a Beta posterior: `alpha` accumulates earned credit, `beta`
 * accumulates missed credit, and the score is `alpha / (alpha + beta)`. With
 * the Beta(1, 1) prior, no evidence reads as 0.5 with zero confidence, one
 * correct answer reads as 2/3 with low confidence, and only a run of evidence
 * pulls the score far from the middle. That is deliberate: a generated course
 * produces a small number of observations per concept, so an estimate that
 * swings on one answer would be worse than showing nothing.
 *
 * `ungraded` evidence is never folded in. A grading outage is the absence of an
 * observation, not a wrong answer, and counting it would poison the posterior.
 *
 * Mastery does not decay here. Forgetting is the review scheduler's job;
 * a review success or lapse is simply new evidence.
 */

import type { ConceptId, ConceptMastery, LearningEvidence } from './types';

/** Pseudo-counts behind the no-evidence prior. */
export const MASTERY_PRIOR = 1;

/** Beta(1, 1) variance, used to normalise confidence onto 0..1. */
const PRIOR_VARIANCE = 1 / 12;

/** A malformed weight must not erase evidence; treat it as ordinary weight. */
function evidenceWeight(weight: number | undefined): number {
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) return 1;
  return Math.min(4, weight);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** A concept with no evidence: neutral score, zero confidence. */
export function emptyMastery(conceptId: ConceptId): ConceptMastery {
  return {
    conceptId,
    alpha: MASTERY_PRIOR,
    beta: MASTERY_PRIOR,
    evidenceCount: 0,
    lastUpdatedAt: null,
  };
}

/**
 * Fold one graded record into one concept's posterior.
 *
 * A partial score is credit, not a verdict: `0.5` adds half to `alpha` and half
 * to `beta`, so a partially correct answer raises confidence without pretending
 * the concept is mastered. Ungraded records and records with no finite score
 * leave the state untouched.
 */
export function applyEvidenceToConcept(
  state: ConceptMastery,
  evidence: LearningEvidence,
): ConceptMastery {
  if (evidence.outcome !== 'graded') return state;
  if (!Number.isFinite(evidence.score)) return state;

  const weight = evidenceWeight(evidence.weight);
  const score = clamp01(evidence.score);
  const recordedAt = Number.isFinite(evidence.recordedAt)
    ? evidence.recordedAt
    : (state.lastUpdatedAt ?? 0);

  return {
    ...state,
    alpha: state.alpha + score * weight,
    beta: state.beta + (1 - score) * weight,
    evidenceCount: state.evidenceCount + 1,
    lastUpdatedAt: Math.max(state.lastUpdatedAt ?? recordedAt, recordedAt),
  };
}

/**
 * Fold a batch of evidence into a concept map.
 *
 * Untagged records are skipped: there is no concept to update. Duplicate
 * concept ids within one record are folded once, because the record is one
 * observation about each concept, not one observation per mention.
 */
export function masteryByConcept(
  evidence: readonly LearningEvidence[],
): Record<ConceptId, ConceptMastery> {
  const mastery: Record<ConceptId, ConceptMastery> = {};
  for (const record of evidence) {
    if (record.outcome !== 'graded') continue;
    const conceptIds = [...new Set(record.conceptIds)];
    for (const conceptId of conceptIds) {
      const current = mastery[conceptId] ?? emptyMastery(conceptId);
      mastery[conceptId] = applyEvidenceToConcept(current, record);
    }
  }
  return mastery;
}

/** Posterior mean, 0..1. Malformed states degrade to the prior mean. */
export function masteryScore(state: ConceptMastery): number {
  const total = state.alpha + state.beta;
  if (!Number.isFinite(total) || total <= 0) return 0.5;
  return clamp01(state.alpha / total);
}

/**
 * How much the evidence has narrowed the posterior, 0..1.
 *
 * Confidence is `1 - posteriorVariance / priorVariance`. It is zero for no
 * evidence and rises as observations accumulate; it is not a probability that
 * the learner "knows" the concept, only a measure of how much the estimate can
 * be trusted yet. Partial-credit records raise confidence even when their mean
 * contribution is neutral, which is intended: they still reduce uncertainty.
 */
export function masteryConfidence(state: ConceptMastery): number {
  const total = state.alpha + state.beta;
  if (
    !Number.isFinite(total) ||
    total <= 0 ||
    !Number.isFinite(state.alpha) ||
    !Number.isFinite(state.beta)
  ) {
    return 0;
  }
  const variance = (state.alpha * state.beta) / (total * total * (total + 1));
  if (!Number.isFinite(variance)) return 0;
  return clamp01(1 - variance / PRIOR_VARIANCE);
}
