/**
 * Shared output-token budgets for generation stages.
 *
 * A runaway generation loop is a minutes-long, fully-billed failure, so every
 * stage needs a ceiling somewhere below the model's advertised output window.
 * But a ceiling that truncates a legitimate answer is WORSE than no ceiling:
 * the first call is billed, the JSON fails to parse (or the answer is cut
 * mid-sentence), and the retry pays for the same work again.
 *
 * The caps below are therefore loose tripwires, not target lengths. Normal
 * outputs sit far below them; they only stop a looping/degenerate generation
 * from billing a full window. When in doubt between a cap and a truncation,
 * prefer the higher cap.
 *
 * - scene content: ~3.5-11.5k output tokens observed; 24k leaves >2x margin.
 * - actions: a few thousand tokens; 12k covers a dense slide plus reasoning.
 * - outlines: a lesson with 12 scenes lands well under 24k.
 * - review/quiz verdicts: small JSON objects; 4k is already generous.
 * - quiz grading: one score + one comment; 2k is ~20x the payload.
 * - exam grading: per-criterion verdicts + feedback; 6k is generous.
 * - exam generation: a 12+ MC / 3 FR exam with analyses; 32k avoids a costly
 *   cut-off on a high-stakes artifact.
 * - PBL narrator turns: one or two visible beats; 4k is generous.
 * - document index batches: section cards/captions per batch; 12k is generous.
 * - agent profiles: 3-5 profiles + voice designs; 8k is generous.
 *
 * Providers count reasoning inside the output budget. When the resolved
 * ThinkingConfig carries an EXPLICIT reasoning budget, that budget is added as
 * headroom above the cap so anticipated reasoning cannot starve the payload.
 * An `enabled` config with NO explicit budget keeps the base cap: unbounded
 * provider-default reasoning is exactly the pathological case the cap exists
 * to fail fast on.
 */

import type { ThinkingConfig } from '@/lib/types/provider';

export const SCENE_CONTENT_OUTPUT_CAP = 24_000;
export const SCENE_ACTIONS_OUTPUT_CAP = 12_000;
export const OUTLINE_OUTPUT_CAP = 24_000;
export const OUTLINE_REVIEW_OUTPUT_CAP = 4_000;
export const QUIZ_VERIFY_OUTPUT_CAP = 4_000;
export const QUIZ_GRADE_OUTPUT_CAP = 2_000;
export const EXAM_GENERATION_OUTPUT_CAP = 32_000;
export const EXAM_GRADING_OUTPUT_CAP = 6_000;
export const PBL_NARRATOR_OUTPUT_CAP = 4_000;
export const DOCUMENT_INDEX_OUTPUT_CAP = 12_000;
export const AGENT_PROFILES_OUTPUT_CAP = 8_000;

/** Explicit reasoning budget to shield from the output cap, if any. */
export function explicitReasoningBudget(thinking: ThinkingConfig | undefined): number {
  if (!thinking || thinking.enabled === false) return 0;
  const budget = thinking.budgetTokens;
  return typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : 0;
}

/**
 * Clamp a stage's output budget to its tripwire plus explicit reasoning
 * headroom, never exceeding the model's real output window.
 */
export function clampOutputBudget(
  cap: number,
  outputWindow: number | undefined,
  thinking?: ThinkingConfig,
): number {
  const target = cap + explicitReasoningBudget(thinking);
  if (typeof outputWindow !== 'number' || !Number.isFinite(outputWindow) || outputWindow <= 0) {
    return target;
  }
  return Math.min(outputWindow, target);
}
