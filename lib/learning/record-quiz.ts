/**
 * The quiz → learning-loop bridge.
 *
 * Called after a reviewed attempt is durable. Evidence and review cards are
 * separate writes on purpose: a card-store failure must not discard the
 * observations, and both are idempotent so a reload can safely retry.
 *
 * Practice attempts never reach this module. Practice is ephemeral by product
 * decision; only the graded attempt recorded by `lib/quiz/runtime` is evidence.
 */

import type { RuntimeStore } from '@openmaic/storage';

import type { QuestionResult } from '@/lib/quiz/grading';
import type { QuizQuestion } from '@/lib/types/stage';
import { getLearnerKey } from '@/lib/runtime/learner-key';

import { evidenceFromQuizAttempt, quizEvidenceItems } from './from-quiz';
import { appendLearningEvidence, ensureReviewCards } from './store';

export interface RecordQuizLearningInput {
  stageId: string;
  sceneId: string;
  attemptId: string;
  questions: readonly QuizQuestion[];
  results: readonly QuestionResult[];
  /** Epoch milliseconds; defaults to now. */
  recordedAt?: number;
  /** Injected by tests and server callers; defaults to the session learner. */
  learnerKey?: string;
  /** Injected by tests and server callers; defaults to the app runtime store. */
  store?: RuntimeStore;
}

/**
 * Persist one reviewed quiz attempt's evidence and its review cards.
 *
 * Cards are created only for items that were actually graded. An ungraded
 * answer is an absent observation, not a wrong answer, so it must not enter
 * the review queue either.
 */
export async function recordQuizLearning(input: RecordQuizLearningInput): Promise<void> {
  const recordedAt =
    typeof input.recordedAt === 'number' && Number.isFinite(input.recordedAt)
      ? input.recordedAt
      : Date.now();
  const learnerKey = input.learnerKey ?? (await getLearnerKey());
  const items = quizEvidenceItems(input.questions);
  const evidence = evidenceFromQuizAttempt({
    learnerKey,
    stageId: input.stageId,
    sceneId: input.sceneId,
    attemptId: input.attemptId,
    recordedAt,
    items,
    results: input.results,
  });
  if (evidence.length === 0) return;

  await appendLearningEvidence(
    { stageId: input.stageId, evidence },
    { learnerKey, store: input.store, now: () => recordedAt },
  );

  const graded = new Set(
    input.results
      .filter((result) => result.status !== 'ungraded')
      .map((result) => result.questionId),
  );
  await ensureReviewCards(
    {
      stageId: input.stageId,
      items: items
        .filter((item) => item.conceptIds !== undefined && graded.has(item.questionId))
        .map((item) => ({
          sceneId: input.sceneId,
          itemId: item.questionId,
          conceptIds: item.conceptIds ?? [],
        })),
    },
    { learnerKey, store: input.store, now: () => recordedAt },
  );
}
