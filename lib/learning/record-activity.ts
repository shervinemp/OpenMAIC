/**
 * The activity → learning-loop bridge.
 *
 * Called after a deterministic run with its evaluation in hand. The write is
 * idempotent per attempt id, so a React effect can retry without double-counting
 * the same submission.
 *
 * A run with no graded check is skipped entirely. That happens when the runner
 * itself failed or timed out, or when the browser runtime is unavailable; the
 * evaluation still renders an honest "ungraded" state, but there is no learner
 * observation to persist. A run with some graded and some ungraded checks is
 * recorded in full, so a partially observable run stays visible.
 *
 * Activities create no review cards yet. See `from-activity.ts`.
 */

import type { RuntimeStore } from '@openmaic/storage';

import type { ActivityCheckResult } from '@/lib/activity/checks';
import { getLearnerKey } from '@/lib/runtime/learner-key';

import { evidenceFromActivityRun } from './from-activity';
import { appendLearningEvidence } from './store';

export interface RecordActivityLearningInput {
  stageId: string;
  sceneId: string;
  /** Stable across retries of one run; see {@link evidenceFromActivityRun}. */
  attemptId: string;
  concepts?: readonly string[];
  results: readonly ActivityCheckResult[];
  /** Epoch milliseconds; defaults to now. */
  recordedAt?: number;
  /** Injected by tests and server callers; defaults to the session learner. */
  learnerKey?: string;
  /** Injected by tests and server callers; defaults to the app runtime store. */
  store?: RuntimeStore;
}

export async function recordActivityLearning(input: RecordActivityLearningInput): Promise<void> {
  if (input.results.length === 0) return;
  // A harness failure says nothing about the learner. Do not persist a log full
  // of ungraded checks for it; the activity UI already shows the run failure.
  if (!input.results.some((result) => result.status !== 'ungraded')) return;

  const recordedAt =
    typeof input.recordedAt === 'number' &&
    Number.isFinite(input.recordedAt) &&
    input.recordedAt >= 0
      ? input.recordedAt
      : Date.now();
  const learnerKey = input.learnerKey ?? (await getLearnerKey());
  const evidence = evidenceFromActivityRun({
    learnerKey,
    stageId: input.stageId,
    sceneId: input.sceneId,
    attemptId: input.attemptId,
    recordedAt,
    concepts: input.concepts,
    results: input.results,
  });

  await appendLearningEvidence(
    { stageId: input.stageId, evidence },
    { learnerKey, store: input.store, now: () => recordedAt },
  );
}
