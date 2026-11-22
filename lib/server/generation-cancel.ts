/**
 * Server-side cancellation for the browser-driven generation flow.
 *
 * The generation-preview page fans out to several API routes (document
 * indexing, web search, outlines, agent profiles). Its client AbortController
 * only closes the fetches — the server kept billing the LLM calls. Each route
 * in the flow creates an explicit per-request AbortController here and passes
 * its signal into the LLM calls it makes. Cancelling a session aborts every
 * controller registered for it.
 *
 * No async-local state and no change to `callLLM`: signal propagation stays
 * explicit at the call sites, like every other abortSignal in this codebase.
 */

export interface RegisteredGenerationCall {
  signal: AbortSignal;
  dispose(): void;
}

const activeBySession = new Map<string, Set<AbortController>>();
/** Sessions cancelled recently, so a request that registers late is still stopped. */
const cancelledSessions = new Map<string, number>();
const CANCELLED_TTL_MS = 10 * 60_000;

function pruneCancelled(): void {
  const now = Date.now();
  for (const [id, at] of cancelledSessions) {
    if (now - at > CANCELLED_TTL_MS) cancelledSessions.delete(id);
  }
}

export function generationSessionIdFrom(req: Request): string | undefined {
  // Some tests (and non-HTTP callers) pass a partial request without headers.
  const value = req.headers?.get?.('x-generation-session')?.trim();
  return value || undefined;
}

/** Create and register the controller for one in-flight generation request. */
export function registerGenerationCall(
  sessionId: string,
  _label: string,
): RegisteredGenerationCall {
  pruneCancelled();
  const controller = new AbortController();
  if (cancelledSessions.has(sessionId)) {
    controller.abort(new DOMException('Generation cancelled by user', 'AbortError'));
    return { signal: controller.signal, dispose: () => undefined };
  }
  let calls = activeBySession.get(sessionId);
  if (!calls) {
    calls = new Set();
    activeBySession.set(sessionId, calls);
  }
  calls.add(controller);

  return {
    signal: controller.signal,
    dispose: () => {
      calls!.delete(controller);
      if (calls!.size === 0) activeBySession.delete(sessionId);
    },
  };
}

/** Combine the client-disconnect signal with the session-cancel signal. */
export function anyAbortSignal(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const defined = signals.filter((signal): signal is AbortSignal => !!signal);
  if (defined.length === 0) return new AbortController().signal;
  if (defined.length === 1) return defined[0];
  const combined = new AbortController();
  for (const signal of defined) {
    if (signal.aborted) {
      combined.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => combined.abort(signal.reason), { once: true });
  }
  return combined.signal;
}

/** Register this request's controller when the browser flow sent a session id. */
export function generationCallFor(req: Request, label: string): RegisteredGenerationCall | undefined {
  const sessionId = generationSessionIdFrom(req);
  return sessionId ? registerGenerationCall(sessionId, label) : undefined;
}

/** Abort every in-flight call for one session. Returns how many were stopped. */
export function cancelGeneration(sessionId: string): number {
  pruneCancelled();
  cancelledSessions.set(sessionId, Date.now());
  const calls = activeBySession.get(sessionId);
  if (!calls) return 0;
  let stopped = 0;
  for (const controller of calls) {
    if (controller.signal.aborted) continue;
    controller.abort(new DOMException('Generation cancelled by user', 'AbortError'));
    stopped += 1;
  }
  // Detach aborted calls so the remaining count confirms cancellation took
  // effect. Late dispose() calls on these controllers are harmless.
  activeBySession.delete(sessionId);
  return stopped;
}

/** Remaining registered calls for one session, after a cancel. */
export function activeGenerationCallCountFor(sessionId: string): number {
  return activeBySession.get(sessionId)?.size ?? 0;
}

/** Snapshot for diagnostics and tests; never exposes controllers. */
export function activeGenerationCallCount(): number {
  let total = 0;
  for (const calls of activeBySession.values()) total += calls.size;
  return total;
}
