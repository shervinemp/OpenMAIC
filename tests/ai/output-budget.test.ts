import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_INDEX_OUTPUT_CAP,
  OUTLINE_OUTPUT_CAP,
  OUTLINE_REVIEW_OUTPUT_CAP,
  SCENE_ACTIONS_OUTPUT_CAP,
  SCENE_CONTENT_OUTPUT_CAP,
  clampOutputBudget,
  explicitReasoningBudget,
} from '@/lib/ai/output-budget';

describe('output budgets', () => {
  it('uses the stage cap when the model window is larger', () => {
    expect(clampOutputBudget(SCENE_CONTENT_OUTPUT_CAP, 128_000)).toBe(SCENE_CONTENT_OUTPUT_CAP);
    expect(clampOutputBudget(SCENE_ACTIONS_OUTPUT_CAP, 128_000)).toBe(SCENE_ACTIONS_OUTPUT_CAP);
    expect(clampOutputBudget(OUTLINE_OUTPUT_CAP, 128_000)).toBe(OUTLINE_OUTPUT_CAP);
    expect(clampOutputBudget(OUTLINE_REVIEW_OUTPUT_CAP, 128_000)).toBe(OUTLINE_REVIEW_OUTPUT_CAP);
    expect(clampOutputBudget(DOCUMENT_INDEX_OUTPUT_CAP, 128_000)).toBe(DOCUMENT_INDEX_OUTPUT_CAP);
  });

  it("never exceeds the model's real output window", () => {
    expect(clampOutputBudget(SCENE_CONTENT_OUTPUT_CAP, 4_096)).toBe(4_096);
    expect(clampOutputBudget(SCENE_ACTIONS_OUTPUT_CAP, 2_048)).toBe(2_048);
  });

  it('adds an explicit reasoning budget as headroom', () => {
    expect(
      clampOutputBudget(SCENE_CONTENT_OUTPUT_CAP, 128_000, {
        enabled: true,
        budgetTokens: 8_000,
      }),
    ).toBe(SCENE_CONTENT_OUTPUT_CAP + 8_000);
  });

  it('does not add headroom for disabled thinking or an unbounded enabled config', () => {
    expect(
      clampOutputBudget(SCENE_CONTENT_OUTPUT_CAP, 128_000, {
        enabled: false,
        budgetTokens: 8_000,
      }),
    ).toBe(SCENE_CONTENT_OUTPUT_CAP);
    expect(
      clampOutputBudget(SCENE_CONTENT_OUTPUT_CAP, 128_000, {
        enabled: true,
      }),
    ).toBe(SCENE_CONTENT_OUTPUT_CAP);
  });

  it('clamps headroom to the model window too', () => {
    expect(
      clampOutputBudget(SCENE_CONTENT_OUTPUT_CAP, 20_000, {
        enabled: true,
        budgetTokens: 8_000,
      }),
    ).toBe(20_000);
  });

  it('ignores non-positive or non-finite explicit budgets', () => {
    expect(explicitReasoningBudget({ enabled: true, budgetTokens: 0 })).toBe(0);
    expect(explicitReasoningBudget({ enabled: true, budgetTokens: -1 })).toBe(0);
    expect(explicitReasoningBudget({ enabled: true, budgetTokens: Number.NaN })).toBe(0);
    expect(explicitReasoningBudget(undefined)).toBe(0);
  });
});
