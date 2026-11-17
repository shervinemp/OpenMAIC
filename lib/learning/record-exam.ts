/**
 * The exam → learning-loop bridge.
 *
 * Called when a graded attempt is reviewed. The write is idempotent, so opening
 * the review twice (or reopening it after a reload) cannot double-count.
 *
 * The attempt records the `ExamSpec.generatedAt` it was drawn from. A
 * regenerated pool reuses seeds and can recycle question ids, so a stale
 * attempt must not be mapped onto the new pool. Legacy attempts without the
 * stamp are not backfilled; the review screen may still show them using the
 * current spec, but they are not trustworthy enough to feed mastery.
 *
 * Exam items do not create review cards: a pool item has no owning scene yet.
 * See `from-exam.ts`.
 */

import type { RuntimeStore } from '@openmaic/storage';

import { resolveAttemptVariant } from '@/lib/exam/variants';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import type { ExamAttempt, ExamSpec } from '@/lib/types/exam';

import { evidenceFromExamAttempt } from './from-exam';
import { appendLearningEvidence } from './store';

export interface RecordExamLearningInput {
  stageId: string;
  spec: ExamSpec;
  attempt: ExamAttempt;
  /** Epoch milliseconds; defaults to the attempt's grading/submission time. */
  recordedAt?: number;
  /** Injected by tests and server callers; defaults to the session learner. */
  learnerKey?: string;
  /** Injected by tests and server callers; defaults to the app runtime store. */
  store?: RuntimeStore;
}

export async function recordExamLearning(input: RecordExamLearningInput): Promise<void> {
  if (input.attempt.kind !== input.spec.kind) {
    console.warn('Skipping exam learning evidence: attempt kind does not match the exam spec.');
    return;
  }
  if (input.attempt.specGeneratedAt === undefined) return;
  if (input.attempt.specGeneratedAt !== input.spec.generatedAt) {
    console.warn('Skipping exam learning evidence: the exam pool was regenerated.');
    return;
  }

  const recordedAt =
    [input.recordedAt, input.attempt.gradedAt, input.attempt.submittedAt].find(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0,
    ) ?? Date.now();

  const learnerKey = input.learnerKey ?? (await getLearnerKey());
  const variant = resolveAttemptVariant(input.spec, input.attempt);
  const evidence = evidenceFromExamAttempt({
    learnerKey,
    stageId: input.stageId,
    attempt: input.attempt,
    variant,
    recordedAt,
  });
  if (evidence.length === 0) return;

  await appendLearningEvidence(
    { stageId: input.stageId, evidence },
    { learnerKey, store: input.store, now: () => recordedAt },
  );
}
