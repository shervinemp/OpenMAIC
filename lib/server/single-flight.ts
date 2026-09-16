/**
 * In-flight coalescing for expensive, idempotent server jobs.
 *
 * Two classroom tabs (or a reload racing a previous load) both kick the same
 * on-load maintenance pass. Without this, each POST re-runs a minutes-long
 * sweep over the whole course and the two runs race the same document — the
 * observed Windows `EPERM rename` storms and lost updates. With it, the
 * second caller simply awaits the first run's result.
 *
 * Coalescing is exact-key only: callers asking for different work (a
 * different scene subset, dry-run vs apply, merge on/off) run separately.
 * Scope is the process; a multi-process deployment would need a shared lock,
 * but the write path's own retry covers that residual case.
 */
const inflight = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const run = task();
  inflight.set(key, run);
  void run
    .catch(() => undefined)
    .then(() => {
      if (inflight.get(key) === run) inflight.delete(key);
    });
  return run;
}

/** Live in-flight job count — observability for tests and diagnostics. */
export function singleFlightCount(): number {
  return inflight.size;
}
