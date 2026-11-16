/**
 * Shared output-token budgets for generation stages.
 *
 * A stage's model advertises an output window, but almost no generation stage
 * should be allowed to use all of it: valid scene/outline/action JSON is small,
 * and a runaway reasoning loop is a minutes-long, fully-billed failure rather
 * than useful output. The browser routes and the one-shot classroom path used
 * to disagree about this (only scene-content had a cap), so a model that
 * looped burned unbounded tokens on every other path.
 *
 * The caps here are deliberately generous relative to observed successful
 * outputs. They are tripwires, not target lengths:
 * - scene content: ~3.5-11.5k output tokens observed; 16k leaves a ~2x margin.
 * - actions: a few thousand tokens; 8k covers a dense slide plus a reasoning
 *   headroom.
 * - outlines: a lesson with 12 scenes lands well under 16k.
 * - review verdicts: a small JSON object; 2k is already generous.
 * - quiz answer verification: a small answers array; 2k is already generous.
 * - document index batches: section cards/captions per batch; 8k is generous.
 *
 * Providers count reasoning inside the output budget. When the resolved
 * ThinkingConfig carries an EXPLICIT reasoning budget, that budget is added as
 * headroom above the cap so anticipated reasoning cannot starve the payload.
 * An `enabled` config with NO explicit budget keeps the base cap: unbounded
 * provider-default reasoning is exactly the pathological case the cap exists
 * to fail fast on.
 */

import type { ThinkingConfig } from '@/lib/types/provider';

export const SCENE_CONTENT_OUTPUT_CAP = 16_000;
export const SCENE_ACTIONS_OUTPUT_CAP = 8_000;
export const OUTLINE_OUTPUT_CAP = 16_000;
export const OUTLINE_REVIEW_OUTPUT_CAP = 2_000;
export const QUIZ_VERIFY_OUTPUT_CAP = 2_000;
export const DOCUMENT_INDEX_OUTPUT_CAP = 8_000;
export const AGENT_PROFILES_OUTPUT_CAP = 4_000;

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
