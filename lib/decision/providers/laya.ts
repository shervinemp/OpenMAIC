/**
 * Laya and Jev-compatible typed decision servers.
 *
 * Wire contract (the adapter posts this shape):
 *
 *   POST {endpoint}/predict
 *   { "state": "...", "questions": [
 *       { "id": "q1", "type": "choice", "prompt": "...", "options": [...] },
 *       { "id": "q2", "type": "score",  "prompt": "...", "min": 0, "max": 10 },
 *       { "id": "q3", "type": "noul",   "prompt": "..." }
 *   ] }
 *
 * and reads `{ "answers": { "<id>": { "choice"|"score"|"noul", "confidence", "abstain" } } }`
 * (an `answers` map nested under `result` is accepted too). `prompt` is also
 * sent as `question` for servers that use the older spelling.
 *
 * The endpoint comes from operator configuration, never from request input,
 * so it is trusted like a server-managed provider base URL and does not go
 * through the user-URL SSRF policy. A localhost/LAN decision server is
 * expected to work without `ALLOW_LOCAL_NETWORKS`; `DECISION_ROUTES` should be
 * protected with the same care as any other provider credential/config.
 */

import { normalizeDecisionResult } from './normalize';
import { withDeadline } from '../timeout';
import type {
  DecisionProvider,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  DecisionSiteConfig,
} from '../types';

export interface TypedHttpProviderOptions {
  /** Test seam; production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

function predictUrl(endpoint: string): string {
  return endpoint.endsWith('/predict') ? endpoint : `${endpoint}/predict`;
}

function wireQuestion(question: DecisionQuestion): Record<string, unknown> {
  if (question.kind === 'choice') {
    return {
      id: question.id,
      type: 'choice',
      prompt: question.prompt,
      question: question.prompt,
      options: question.options,
      multiple: question.multiple === true,
    };
  }
  if (question.kind === 'score') {
    return {
      id: question.id,
      type: 'score',
      prompt: question.prompt,
      question: question.prompt,
      min: question.min,
      max: question.max,
    };
  }
  return {
    id: question.id,
    type: 'noul',
    prompt: question.prompt,
    question: question.prompt,
  };
}

export function createTypedHttpProvider(
  config: DecisionSiteConfig,
  options: TypedHttpProviderOptions = {},
): DecisionProvider {
  const endpoint = config.endpoint;
  if (!endpoint) throw new Error(`Decision site "${config.site}" has no endpoint`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const provider = config.provider;

  return {
    id: provider,
    async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
      const deadline = withDeadline(signal, config.timeoutMs);
      const startedAt = Date.now();
      try {
        const response = await fetchImpl(predictUrl(endpoint), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            state: request.state,
            questions: request.questions.map(wireQuestion),
          }),
          signal: deadline.signal,
        });
        if (!response.ok) {
          // Do not include the response body: it can echo learner content.
          throw new Error(`Decision server returned HTTP ${response.status}`);
        }
        const raw = (await response.json()) as unknown;
        return normalizeDecisionResult({
          raw,
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
