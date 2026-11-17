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
        body: JSON.stringify({
          state: request.state,
          questions: request.questions.map(wireQuestion),
        }),
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
