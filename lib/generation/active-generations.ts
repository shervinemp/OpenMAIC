/**
 * Which courses are actively generating, for read-only UI (Home cards).
 *
 * The authoritative signal is the cross-tab generation lease: a batch holds a
 * Web Lock named `openmaic-generate:<stageId>` for its whole run. Querying it
 * tells us whether work is actually in flight, without adding any state to the
 * generator itself. Where Web Locks are unavailable, a live `active` intent is
 * the best available signal (the generator heartbeats it per scene).
 */

const LEASE_PREFIX = 'openmaic-generate:';
export const INTENT_PREFIX = 'openmaic:generation-intent:';

interface LockInfo {
  name?: string;
}

interface LockManager {
  query?: () => Promise<{ held?: LockInfo[] }>;
}

function fromIntent(): Set<string> {
  const stages = new Set<string>();
  if (typeof window === 'undefined') return stages;
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith(INTENT_PREFIX)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      try {
        const value = JSON.parse(raw) as { intent?: string };
        if (value.intent === 'active') stages.add(key.slice(INTENT_PREFIX.length));
      } catch {
        // ignore malformed records
      }
    }
  } catch {
    // storage blocked — fall back to "unknown", i.e. no active badge
  }
  return stages;
}

export async function readActiveGenerationStageIds(): Promise<Set<string>> {
  if (typeof navigator === 'undefined') return new Set();
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (typeof locks?.query !== 'function') return fromIntent();
  try {
    const state = await locks.query();
    const held = state?.held ?? [];
    const stages = new Set(
      held
        .map((lock) => lock.name ?? '')
        .filter((name) => name.startsWith(LEASE_PREFIX))
        .map((name) => name.slice(LEASE_PREFIX.length)),
    );
    // The lease is authoritative, but a run that just started (or whose query
    // raced the lock request) may not appear yet; the intent covers that window.
    for (const stage of fromIntent()) stages.add(stage);
    return stages;
  } catch {
    return fromIntent();
  }
}
