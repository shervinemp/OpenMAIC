import type { AICallFn } from '@openmaic/generation';

import { callLLM } from '@/lib/ai/llm';
import {
  AGENT_PROFILES_OUTPUT_CAP,
  SCENE_ACTIONS_OUTPUT_CAP,
  SCENE_CONTENT_OUTPUT_CAP,
  clampOutputBudget,
} from '@/lib/ai/output-budget';
import type { LlmStage } from '@/lib/server/model-routes';
import { resolveModel } from '@/lib/server/resolve-model';

const CONTENT_TYPES = new Set(['slide', 'quiz', 'activity', 'interactive', 'pbl']);

export function sceneContentStage(type?: string): LlmStage {
  return type && CONTENT_TYPES.has(type) ? (`scene-content:${type}` as LlmStage) : 'scene-content';
}

/**
 * The shared tripwire for a stage routed through this factory. Agent tools
 * drive the same generators as the browser routes, so they must inherit the
 * same output caps; an unknown stage keeps the model window (the caller's
 * deliberate choice).
 */
function stageOutputCap(stage: string): number | undefined {
  if (stage.startsWith('scene-content')) return SCENE_CONTENT_OUTPUT_CAP;
  if (stage === 'scene-actions') return SCENE_ACTIONS_OUTPUT_CAP;
  if (stage === 'agent-profiles') return AGENT_PROFILES_OUTPUT_CAP;
  return undefined;
}

/** Bind the generation package's neutral callback seam to server stage routing. */
export function createGenerationAiCallFactory(options?: {
  abortSignal?: AbortSignal;
}): (stage: LlmStage) => AICallFn {
  const calls = new Map<LlmStage, AICallFn>();
  return (stage) => {
    const cached = calls.get(stage);
    if (cached) return cached;
    let resolved: Awaited<ReturnType<typeof resolveModel>> | undefined;
    const call: AICallFn = async (systemPrompt, userPrompt) => {
      resolved ??= await resolveModel({ stage });
      const outputCap = stageOutputCap(stage);
      const result = await callLLM(
        {
          model: resolved.model,
          system: systemPrompt,
          prompt: userPrompt,
          maxOutputTokens: outputCap
            ? clampOutputBudget(
                outputCap,
                resolved.modelInfo?.outputWindow,
                resolved.thinkingConfig,
              )
            : resolved.modelInfo?.outputWindow,
          maxRetries: 0,
          abortSignal: options?.abortSignal,
        },
        stage,
        undefined,
        resolved.thinkingConfig,
        { serverManaged: resolved.serverManaged },
      );
      return result.text;
    };
    calls.set(stage, call);
    return call;
  };
}
