/**
 * An id for one algorithmically graded activity run.
 *
 * Evidence is idempotent per attempt id, so a retry of the same run must reuse
 * it while a genuinely new run gets a new one. `randomUUID` is available in
 * secure contexts and in modern browsers; the time+random fallback keeps the
 * id unique in a plain-HTTP LAN deployment without pulling in a dependency.
 */
export function createActivityAttemptId(now = Date.now()): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `run_${uuid}`;
  return `run_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
