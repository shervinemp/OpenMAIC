/**
 * Turn one deterministic activity run into learning evidence.
 *
 * Activity checks are already binary: passed, failed, or ungraded. The adapter
 * never reinterprets them and never invents a score. A runner-level failure is
 * ungraded for every check, and the persistence bridge skips a run where
 * nothing could be graded at all.
 *
 * Concepts live on the activity, not on individual checks: a lab teaches one
 * small set of ideas and every check is evidence about that set. An untagged
 * legacy lab still produces item evidence, but cannot move a concept estimate.
 *
 * Activities do not create review cards. A check is a completion signal for an
 * application task, not a memory prompt, and there is no per-check question to
 * show in the review session.
 */

import { normalizeConceptTags } from '@openmaic/dsl';

import type { ActivityCheckResult } from '@/lib/activity/checks';

import type { LearningEvidence } from './types';

export interface ActivityEvidenceInput {
  learnerKey: string;
  stageId: string;
  sceneId: string;
  /**
   * Identifies one submitted run. A retry of the same run must reuse it; a
   * fresh run gets a fresh id so distinct attempts are not collapsed.
   */
  attemptId: string;
  /** Epoch milliseconds shared by every record from this run. */
  recordedAt: number;
  /** Scene-level concept tags; missing tags leave every check untagged. */
  concepts?: readonly string[];
  results: readonly ActivityCheckResult[];
}

function evidenceId(stageId: string, sceneId: string, attemptId: string, checkId: string): string {
  return `${stageId}:activity:${sceneId}:${attemptId}:${checkId}`;
}

/**
 * One record per check in the run. A check the evaluator could not grade stays
 * `ungraded`, so a harness outage is visible without counting as a miss.
 */
export function evidenceFromActivityRun(input: ActivityEvidenceInput): LearningEvidence[] {
  const conceptIds = normalizeConceptTags(input.concepts) ?? [];

  return input.results.map((result) => ({
    id: evidenceId(input.stageId, input.sceneId, input.attemptId, result.checkId),
    learnerKey: input.learnerKey,
    stageId: input.stageId,
    itemId: result.checkId,
    conceptIds,
    source: 'activity',
    score: result.status === 'passed' ? 1 : 0,
    outcome: result.status === 'ungraded' ? 'ungraded' : 'graded',
    recordedAt: input.recordedAt,
  }));
}
