/**
 * Async-context carrier for decoder-enforced JSON output.
 *
 * Some decision sites ask a chat model for a strict JSON object. Prompting is
 * usually enough, but a small local model can still wrap the answer in prose
 * or markdown. OpenAI-compatible servers expose a decoder-level constraint
 * (`response_format: {"type":"json_object"}`), and that constraint has to be
 * added by the shared transport wrapper, which cannot see the caller's intent.
 * This module carries the intent, exactly like `thinking-context`.
 *
 * Server-only: `providers.ts` reads the store through `globalThis`, so it never
 * imports `node:async_hooks` itself (it is also evaluated on the client).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const outputGlobal = globalThis as typeof globalThis & {
  __jsonOutputContext?: AsyncLocalStorage<boolean>;
};

// Reuse one store if Next evaluates this module more than once; an in-flight
// call must stay visible to the transport wrapper in every bundle.
export const jsonOutputContext = (outputGlobal.__jsonOutputContext ??=
  new AsyncLocalStorage<boolean>());

/**
 * Run one LLM call with a JSON-object response requested on the wire.
 *
 * The context stays set for the whole call, including an internal fallback
 * model, because both are answering the same JSON task.
 */
export function withJsonObjectOutput<T>(fn: () => Promise<T>): Promise<T> {
  return jsonOutputContext.run(true, fn);
}
