/**
 * Cross-tab generation lease backed by Web Locks.
 *
 * Several surfaces can start work for the same course (two classroom tabs, two
 * generation-preview tabs). A lease serializes that to one owner: a claimant
 * that loses the race gets `null` and must not run its pipeline, while the
 * holder keeps the lock parked until it calls the returned release function.
 *
 * Degrades to a no-op release when Web Locks are unavailable (single-tab
 * browsers, SSR), so behaviour is unchanged there.
 */

export type LeaseRelease = () => void;

export async function claimGenerationLease(key: string): Promise<LeaseRelease | null> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return () => {};
  }
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return new Promise<LeaseRelease | null>((resolveOuter) => {
    void navigator.locks
      .request(key, { ifAvailable: true }, (lock: unknown) => {
        if (!lock) {
          resolveOuter(null);
          return undefined;
        }
        resolveOuter(() => release());
        return parked as unknown as Promise<void>;
      })
      .catch(() => {
        resolveOuter(() => release());
      });
  });
}
