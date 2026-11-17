/**
 * Chat-model adapter for the decision layer.
 *
 * This is the interchangeable path: any model already in the registry —
 * OpenAI, Gemini, Ollama, Lemonade, vLLM — can stand in for a typed decision
 * model. It is still generative, so it reports whatever confidence it puts in
 * the JSON; absent confidence is treated as `0` and can never drive `triage`.
 *
 * The prompt is deliberately schema-only: no chain of thought, no prose. The
 * shared normalizer does the rest.
 */

import { callLLM } from '@/lib/ai/llm';
import { clampOutputBudget } from '@/lib/ai/output-budget';
import { parseJsonResponse } from '@/lib/generation/json-repair';
import { resolveModel } from '@/lib/server/resolve-model';

import { normalizeDecisionResult } from './normalize';
import { withDeadline } from '../timeout';
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  DecisionSiteConfig,
} from '../types';

export interface ChatDecisionProviderOptions {
  /** Test seam; production resolves the real registry model. */
  resolve?: typeof resolveModel;
}

const SYSTEM_PROMPT = `You are a typed decision engine. Answer the questions about the provided state.

Reply ONLY with JSON in this exact shape:
{"answers":{"<question id>":{"choice":"<option value or array of values>","score":<number>,"noul":<0..1>,"confidence":<0..1>,"abstain":<true|false>}}}

Rules:
- Use only the field named by the question kind: choice, score, or noul.
- For choice questions, return the option VALUE (for example "A"), never the label. For multiple-select questions, return an array of values.
- score must stay within the question's min and max.
- noul is the probability that the answer is yes, from 0 to 1.
- confidence is your probability that the answer is correct, from 0 to 1.
- If you cannot decide, set abstain to true instead of guessing.
- Do not include explanations, markdown, or any text outside the JSON object.`;

function questionPayload(request: DecisionRequest): unknown {
  return request.questions.map((question) =>
    question.kind === 'choice'
      ? {
          id: question.id,
          kind: 'choice',
          prompt: question.prompt,
          options: question.options,
          multiple: question.multiple === true,
        }
      : question.kind === 'score'
        ? {
            id: question.id,
            kind: 'score',
            prompt: question.prompt,
            min: question.min,
            max: question.max,
          }
        : { id: question.id, kind: 'noul', prompt: question.prompt },
  );
}

export function createChatDecisionProvider(
  config: DecisionSiteConfig,
  options: ChatDecisionProviderOptions = {},
): DecisionProvider {
  if (!config.model) throw new Error(`Decision site "${config.site}" has no chat model`);
  const resolve = options.resolve ?? resolveModel;
  const provider = `chat:${config.model}`;

  return {
    id: provider,
    async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
      const resolved = await resolve({ modelString: config.model });
      const deadline = withDeadline(signal, config.timeoutMs);
      const startedAt = Date.now();
      try {
        const result = await callLLM(
          {
            model: resolved.model,
            system: SYSTEM_PROMPT,
            prompt: `STATE:\n${request.state}\n\nQUESTIONS:\n${JSON.stringify(
              questionPayload(request),
              null,
              2,
            )}`,
            maxOutputTokens: clampOutputBudget(
              1_200,
              resolved.modelInfo?.outputWindow,
              resolved.thinkingConfig,
            ),
            temperature: 0,
            abortSignal: deadline.signal,
          },
          `decision:${config.site}`,
          undefined,
          resolved.thinkingConfig,
          { serverManaged: resolved.serverManaged },
        );
        const parsed = parseJsonResponse<{ answers?: unknown }>(result.text);
        if (!parsed) throw new Error('Decision model returned unparseable JSON');
        return normalizeDecisionResult({
          raw: parsed,
          questions: request.questions,
          provider,
          latencyMs: Date.now() - startedAt,
        });
      } finally {
        deadline.cleanup();
      }
    },
  };
}
