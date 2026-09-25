/**
 * Reader for `apiSuccess` bodies. The contract is FLAT —
 * `{ success: true, ...payload }` — there is no `data` wrapper; clients that
 * guessed one silently read `undefined`. Both the reader and the writer live
 * behind this pair so the shape can never drift apart again.
 *
 * Kept free of `next/server` imports so client code (the on-load maintenance
 * pipeline) can use it without pulling server-only modules into the bundle.
 * Returns null for error bodies or malformed JSON shapes; callers fall back to
 * their own defaults, never to a crash.
 */
export function readApiPayload<T extends Record<string, unknown>>(body: unknown): T | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (record.success !== true) return null;
  return record as T;
}
