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
 * The endpoint is chosen in Settings and arrives in a request header, so it is
 * user-supplied (not operator-only). Keep the response guards below strict and
 * treat the endpoint with the same care as any other client-provided base URL.
 *
 * Reliability is bounded on purpose. One transient failure gets one retry,
 * and both attempts share the configured timeout: a server that already
 * consumed the whole budget is not retried. A non-JSON content type or a body
 * over the size cap is deterministic, so it fails immediately instead of
 * spending the remaining budget on the same broken response.
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

/** A bounded response keeps a misconfigured endpoint from exhausting memory. */
export const MAX_DECISION_RESPONSE_BYTES = 512 * 1024;

const MAX_ATTEMPTS = 2;
const MIN_RETRY_BUDGET_MS = 250;
const DEFAULT_RETRY_DELAY_MS = 100;

export interface TypedHttpProviderOptions {
  /** Test seam; production uses the global fetch. */
  fetchImpl?: typeof fetch;
  /** Delay before the single retry. Defaults to 100ms. */
  retryDelayMs?: number;
  /** Test seam for the response size guard. */
  maxResponseBytes?: number;
  /**
   * Wire protocol. Inferred from the endpoint path when omitted: a
   * `/v1/systemone` route (Laya/Jev) uses the object-shaped Jev contract,
   * every other typed endpoint keeps the legacy `/predict` array contract.
   */
  wire?: 'predict' | 'systemone';
}

/**
 * A response the adapter refuses to interpret. `retryable` separates a
 * transient wire failure from a deterministic protocol violation.
 */
export class TypedDecisionResponseError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = 'TypedDecisionResponseError';
    this.retryable = retryable;
    this.status = status;
  }
}

/**
 * Bare origins keep the historical `/predict` convention. An endpoint that
 * already carries a path (for example Laya's `/v1/systemone`) is used as-is so
 * a typed server with a non-root route can be configured directly.
 */
function predictUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  if (trimmed.endsWith('/predict')) return trimmed;
  try {
    const path = new URL(trimmed).pathname;
    if (path !== '/' && path !== '') return trimmed;
  } catch {
    // Malformed endpoints keep the old behaviour; the request will fail and
    // the router falls back to the LLM baseline.
  }
  return `${trimmed}/predict`;
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

/** Jev/Laya wire shape: questions keyed by id, with `instructions` + `criteria`. */
function wireQuestionJev(question: DecisionQuestion): Record<string, unknown> {
  if (question.kind === 'choice') {
    return {
      type: 'choice',
      instructions: question.prompt,
      criteria: Object.fromEntries(
        question.options.map((option) => [String(option.value), String(option.label ?? option.value)]),
      ),
    };
  }
  if (question.kind === 'score') {
    const min = Math.ceil(question.min ?? 0);
    const max = Math.floor(question.max ?? 1);
    const count = Math.max(2, Math.min(32, max - min + 1));
    return {
      type: 'score',
      instructions: question.prompt,
      criteria: Array.from({ length: count }, (_, index) => String(min + index)),
    };
  }
  return { type: 'noul', instructions: question.prompt };
}

function requestBody(request: DecisionRequest, jevWire: boolean): unknown {
  if (!jevWire) {
    return { state: request.state, questions: request.questions.map(wireQuestion) };
  }
  return {
    state: request.state,
    questions: Object.fromEntries(
      request.questions.map((question) => [question.id, wireQuestionJev(question)]),
    ),
  };
}

function isJsonContentType(contentType: string): boolean {
  if (!contentType) return true;
  return (
    contentType === 'application/json' ||
    contentType === 'text/json' ||
    contentType === 'text/plain' ||
    contentType.endsWith('+json')
  );
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Read a response body with a hard byte cap while it streams in. */
async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maxBytes) {
      throw new TypedDecisionResponseError('Decision response exceeded the size cap', false);
    }
  }

  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new TypedDecisionResponseError('Decision response exceeded the size cap', false);
    }
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TypedDecisionResponseError('Decision response exceeded the size cap', false);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType && !isJsonContentType(contentType)) {
    // An HTML error page or a binary payload is not going to become JSON on a
    // second attempt. Do not echo the body: it can contain learner content.
    throw new TypedDecisionResponseError(
      `Decision server returned ${contentType} instead of JSON`,
      false,
    );
  }

  const text = await readCappedText(response, maxBytes);
  try {
    // A UTF-8 BOM is legal at the start of a JSON document but `JSON.parse`
    // rejects it; some small Python servers write one.
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    throw new TypedDecisionResponseError('Decision server returned invalid JSON', true);
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof TypedDecisionResponseError) return error.retryable;
  if (error instanceof DOMException) return error.name === 'TimeoutError';
  // A fetch transport failure is transient by default: connection reset,
  // DNS hiccup, or a server still starting up.
  return true;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Decision call aborted', 'AbortError');
}

export function createTypedHttpProvider(
  config: DecisionSiteConfig,
  options: TypedHttpProviderOptions = {},
): DecisionProvider {
  const endpoint = config.endpoint;
  if (!endpoint) throw new Error(`Decision site "${config.site}" has no endpoint`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const provider = config.provider;
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const maxResponseBytes = Math.max(1024, options.maxResponseBytes ?? MAX_DECISION_RESPONSE_BYTES);
  const url = predictUrl(endpoint);
  const jevWire =
    (options.wire ?? (url.includes('/v1/systemone') ? 'systemone' : 'predict')) === 'systemone';

  const attemptOnce = async (
    request: DecisionRequest,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> => {
    const deadline = withDeadline(signal, timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(requestBody(request, jevWire)),
        signal: deadline.signal,
      });
      if (!response.ok) {
        // Do not include the response body: it can echo learner content.
        throw new TypedDecisionResponseError(
          `Decision server returned HTTP ${response.status}`,
          retryableStatus(response.status),
          response.status,
        );
      }
      return await readJson(response, maxResponseBytes);
    } finally {
      deadline.cleanup();
    }
  };

  return {
    id: provider,
    async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
      const startedAt = Date.now();
      const deadlineAt = startedAt + config.timeoutMs;
      let lastError: unknown;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        if (signal?.aborted) throw abortReason(signal);
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) break;

        try {
          const raw = await attemptOnce(request, signal, remaining);
          return {
            ...normalizeDecisionResult({
              raw,
              questions: request.questions,
              provider,
              latencyMs: Date.now() - startedAt,
            }),
            attempts: attempt,
          };
        } catch (error) {
          lastError = error;
          if (!isRetryable(error) || attempt >= MAX_ATTEMPTS || signal?.aborted) throw error;

          const remainingAfterFailure = deadlineAt - Date.now();
          if (remainingAfterFailure <= MIN_RETRY_BUDGET_MS) break;
          await delay(Math.min(retryDelayMs, remainingAfterFailure - MIN_RETRY_BUDGET_MS));
        }
      }

      if (signal?.aborted) throw abortReason(signal);
      throw (
        lastError ?? new TypedDecisionResponseError('Decision call exceeded its time budget', true)
      );
    },
  };
}
