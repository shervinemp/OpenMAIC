/**
 * The observation every practice surface can write and every learning surface
 * can read.
 *
 * A quiz result, an exam item, an activity check, and a PBL signal all answer
 * the same question: what did this learner do, on which item, about which
 * concepts, and how did it go? Keeping that answer in one shape is what makes
 * mastery, review scheduling, and remediation possible without each feature
 * inventing its own history.
 *
 * This module deliberately owns no persistence. Callers append to a log they
 * already scope (RuntimeStore, a course document, a test fixture), and the
 * pure reducers in this directory fold it.
 */

/** Stable identity of a teachable idea. The course owns the vocabulary. */
export type ConceptId = string;

/** Where a learning observation came from. */
export type LearningEvidenceSource = 'quiz' | 'exam' | 'activity' | 'pbl' | 'review';

/**
 * One graded observation about one learner and one item.
 *
 * `ungraded` is a first-class outcome, not a zero. The platform's rule is that
 * a grading outage must never look like a wrong answer; mastery and review both
 * skip these records rather than folding them in. An untagged item
 * (`conceptIds` empty) is still valid evidence about the item, but cannot move
 * a concept estimate.
 */
export interface LearningEvidence {
  /** Idempotency key. Re-appending the same id is a no-op. */
  id: string;
  /** Learner partition the observation belongs to. */
  learnerKey: string;
  stageId: string;
  /** Item the learner answered (quiz question id, exam question id, check id). */
  itemId: string;
  conceptIds: readonly ConceptId[];
  source: LearningEvidenceSource;
  /** 0..1 share of the item earned. Ignored when `outcome` is `ungraded`. */
  score: number;
  outcome: 'graded' | 'ungraded';
  /** Epoch milliseconds. */
  recordedAt: number;
  /** Relative weight, default 1. Clamped to a small positive range. */
  weight?: number;
}

/**
 * A concept's mastery as a Beta posterior over graded evidence.
 *
 * `alpha` counts earned credit and `beta` counts missed credit. The prior
 * Beta(1, 1) means "no evidence": score 0.5, confidence 0. A single running
 * accuracy would hide how little evidence sits behind it; the posterior keeps
 * the estimate and the uncertainty separate.
 */
export interface ConceptMastery {
  conceptId: ConceptId;
  alpha: number;
  beta: number;
  /** Number of graded records folded in. Not weighted. */
  evidenceCount: number;
  /** Epoch milliseconds of the most recent folded record. */
  lastUpdatedAt: number | null;
}

/** Self-reported difficulty after a review. */
export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

/**
 * One review card.
 *
 * The scheduler is per item, not per concept: a learner reviews a concrete
 * question, and that review is evidence about every concept the item covers.
 * `intervalDays` is zero while a lapsed card is in short-term relearning.
 */
export interface ReviewCard {
  /**
   * Usually `stageId:sceneId:itemId`: item ids are only unique inside a scene,
   * so a course-wide card needs the scene segment to stay stable across
   * attempts and avoid colliding with another quiz's `q1`.
   */
  cardId: string;
  conceptIds: readonly ConceptId[];
  /** SM-2 ease factor, never below `MIN_REVIEW_EASE`. */
  ease: number;
  intervalDays: number;
  /** Consecutive successful reviews. Reset by `again`. */
  repetitions: number;
  /** Times the card was rated `again` after being learned. */
  lapses: number;
  /** Epoch milliseconds. A card is due when `dueAt <= now`. */
  dueAt: number;
  lastReviewedAt?: number;
}
