/**
 * Placement and adaptive routing over the learner's own evidence.
 *
 * A course is a sequence of lessons, and a learner arrives with a history that
 * may already cover some of them. Two decisions follow from that history:
 *
 * - repair first: a concept the learner has missed at least twice is worth
 *   revisiting before moving on;
 * - place conservatively: a leading lesson can be skipped only when every
 *   concept linked to it is known from at least three graded observations.
 *
 * The asymmetry is deliberate. A false "review" costs a few minutes; a false
 * "skip" silently removes instruction the learner needed. So review needs two
 * observations, while a skip needs three plus a high posterior mean, the walk
 * stops at the first lesson that is not fully known, and a placement is only
 * reported when at least one leading lesson was actually skipped. If nothing
 * can be skipped, the honest answer is "start from the beginning", not a
 * course-order guess dressed up as a decision.
 *
 * Nothing here navigates: the caller offers the decision and the learner
 * chooses. Evidence is the same bounded, first-write-wins log the rest of the
 * module uses. Ungraded records never reach this function (mastery skips them),
 * and a concept with a single observation is never enough in either direction.
 */

import { masteryScore } from './mastery';
import type { ConceptId, ConceptMastery } from './types';

/**
 * A lesson is "known" at a 0.8 posterior mean after three graded observations.
 * Three perfect answers is the smallest sample that reaches 0.8 under the
 * Beta(1, 1) prior, so a skip cannot be bought with one lucky answer or a
 * couple of self-ratings.
 */
export const ROUTE_KNOWN_SCORE = 0.8;
export const ROUTE_KNOWN_MIN_OBSERVATIONS = 3;

/**
 * A lesson is "weak" below a 0.6 posterior mean after two observations. One
 * wrong answer is not enough to route a learner backwards; two observations
 * with at least one miss is.
 */
export const ROUTE_WEAK_SCORE = 0.6;
export const ROUTE_WEAK_MIN_OBSERVATIONS = 2;

/** One lesson the router can point at. */
export interface RouteLesson {
  sceneId: string;
  title: string;
  /** Course order, ascending. The planner sorts defensively. */
  order: number;
  /** Concepts the lesson teaches, deduplicated and normalized by the caller. */
  conceptIds: readonly ConceptId[];
}

export type RouteAbstainReason = 'no-tagged-lessons' | 'insufficient-evidence' | 'all-known';

/**
 * The router's answer is advisory. `review` points at the earliest lesson with
 * an observed weakness; `start` is the first lesson not proven known, with the
 * leading lessons that were skipped; `abstain` says the evidence (or the
 * course vocabulary) is not there yet.
 */
export type LearningRoute =
  | {
      kind: 'review';
      lesson: RouteLesson;
      /** The lesson's weak concepts, in the lesson's concept order. */
      conceptIds: readonly ConceptId[];
    }
  | {
      kind: 'start';
      lesson: RouteLesson;
      /**
       * Leading lessons proven known. Never empty: without a skip there is no
       * placement decision, and the router abstains instead.
       */
      skipped: readonly RouteLesson[];
    }
  | { kind: 'abstain'; reason: RouteAbstainReason };

export interface PlanLearningRouteInput {
  lessons: readonly RouteLesson[];
  /** Mastery keyed by concept id, from `masteryByConcept`. */
  mastery: Readonly<Record<ConceptId, ConceptMastery>>;
}

function isKnown(state: ConceptMastery | undefined): boolean {
  if (!state) return false;
  return (
    state.evidenceCount >= ROUTE_KNOWN_MIN_OBSERVATIONS && masteryScore(state) >= ROUTE_KNOWN_SCORE
  );
}

function isWeak(state: ConceptMastery | undefined): boolean {
  if (!state) return false;
  return (
    state.evidenceCount >= ROUTE_WEAK_MIN_OBSERVATIONS && masteryScore(state) < ROUTE_WEAK_SCORE
  );
}

/**
 * Decide where a learner should work next.
 *
 * Order is settled before anything else: a caller may hand over lessons in
 * discovery order, and the decision must not depend on it. A lesson with no
 * concepts is not a route target and is ignored.
 */
export function planLearningRoute({ lessons, mastery }: PlanLearningRouteInput): LearningRoute {
  const ordered = lessons
    .filter((lesson) => lesson.conceptIds.length > 0)
    .slice()
    .sort((a, b) => a.order - b.order || a.sceneId.localeCompare(b.sceneId));

  if (ordered.length === 0) {
    return { kind: 'abstain', reason: 'no-tagged-lessons' };
  }

  // Repair an observed weakness before advancing. The earliest weak lesson
  // wins, so a later gap cannot jump the queue over an earlier one.
  for (const lesson of ordered) {
    const conceptIds = [...new Set(lesson.conceptIds)];
    const weak = conceptIds.filter((conceptId) => isWeak(mastery[conceptId]));
    if (weak.length > 0) {
      return { kind: 'review', lesson, conceptIds: weak };
    }
  }

  // Skip only a run of leading lessons that are entirely known. The first
  // lesson with an unknown or untested concept becomes the start, but only if
  // there is a skip to justify calling it a placement.
  const skipped: RouteLesson[] = [];
  for (const lesson of ordered) {
    const conceptIds = [...new Set(lesson.conceptIds)];
    if (conceptIds.every((conceptId) => isKnown(mastery[conceptId]))) {
      skipped.push(lesson);
      continue;
    }
    return skipped.length > 0
      ? { kind: 'start', lesson, skipped }
      : { kind: 'abstain', reason: 'insufficient-evidence' };
  }

  return { kind: 'abstain', reason: 'all-known' };
}
