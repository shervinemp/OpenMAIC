import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Server-side cancellation for the browser-driven generation flow.
 *
 * The generation-preview page fans out to several API routes (document
 * indexing, web search, outlines, agent profiles). Its client AbortController
 * only closes the fetches — the server kept billing the LLM calls. Each request
 * in the flow carries the session id in `x-generation-session`, so a cancel can
 * abort every in-flight call for that session. `callLLM` picks up the signal
 * from the async context below without every call site needing to thread it.
 */
export interface ActiveGenerationCall {
  controller: AbortController;
  label: string;
  startedAt: number;
}

const activeBySession = new Map<string, Set<ActiveGenerationCall>>();
const callContext = new AsyncLocalStorage<AbortController>();

/** The signal for the generation request this async context belongs to. */
export function getGenerationAbortSignal(): AbortSignal | undefined {
  return callContext.getStore()?.signal;
}

export function generationSessionIdFrom(req: Request): string | undefined {
  const value = req.headers.get('x-generation-session')?.trim();
  return value || undefined;
}

/** Run a route handler with an abortable slot registered for its session. */
export function runWithGenerationCancel<T>(
  sessionId: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let calls = activeBySession.get(sessionId);
  if (!calls) {
    calls = new Set();
    activeBySession.set(sessionId, calls);
  }
  const entry: ActiveGenerationCall = { controller, label, startedAt: Date.now() };
  calls.add(entry);

  return callContext.run(controller, fn).finally(() => {
    calls!.delete(entry);
    if (calls!.size === 0) activeBySession.delete(sessionId);
  });
}

/** Abort every in-flight call for one session. Returns how many were stopped. */
export function cancelGeneration(sessionId: string): number {
  const calls = activeBySession.get(sessionId);
  if (!calls) return 0;
  let stopped = 0;
  for (const call of calls) {
    if (call.controller.signal.aborted) continue;
    call.controller.abort(new DOMException('Generation cancelled by user', 'AbortError'));
    stopped += 1;
  }
  return stopped;
}

/** Escape hatch for a stuck session whose id the operator does not have. */
export function cancelAllGenerations(): number {
  let stopped = 0;
  for (const sessionId of [...activeBySession.keys()]) {
    stopped += cancelGeneration(sessionId);
  }
  return stopped;
}

/** Snapshot for diagnostics and tests; never exposes controllers. */
export function activeGenerationLabels(): string[] {
  const labels: string[] = [];
  for (const calls of activeBySession.values()) {
    for (const call of calls) labels.push(call.label);
  }
  return labels;
}

/**
 * Wrap a route handler so its LLM calls are cancellable by session id.
 * Requests without the header behave exactly as before.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withGenerationCancel<T extends (...args: any[]) => Promise<Response>>(
  handler: T,
): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((...args: any[]) => {
    const req = args[0] as Request | undefined;
    const sessionId = req ? generationSessionIdFrom(req) : undefined;
    if (!sessionId) return handler(...args);
    const label = req?.url ? new URL(req.url).pathname : 'generation';
    return runWithGenerationCancel(sessionId, label, () => handler(...args));
  }) as T;
}
