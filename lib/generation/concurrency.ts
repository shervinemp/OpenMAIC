/**
 * Bounded-concurrency map over an async task list. Preserves input order in
 * the result array while capping in-flight work to `limit`. Used for the
 * independent LLM calls of the digest + multi-unit outline stages (which are
 * otherwise fully sequential and dominate a semester run's wall time).
 */

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/** Default concurrency for the digest + outline stages. */
export const DEFAULT_LLM_CONCURRENCY = 3;
