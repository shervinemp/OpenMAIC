/**
 * Durable "does the owner still want this course generating?" intent.
 *
 * An AbortController cannot tell a deliberate Stop from a tab navigation, a
 * reload or a Fast Refresh. All of them look identical to the running batch,
 * so the old code parked every one of them and waited for a manual Resume —
 * an accidental reload could idle a 600-scene run for hours.
 *
 * This module keeps that decision OUT of the signal and in a small, durable
 * record per course:
 *   - an explicit Start / Resume marks the intent `active`;
 *   - an explicit Pause / Cancel / Stop marks it `stopped`;
 *   - an unmount, navigation or reload touches nothing.
 * On the next classroom mount, an unfinished course with `active` intent
 * resumes by itself. The number of automatic resumes is bounded (and the
 * budget resets on any explicit action), so a broken tab cannot loop forever
 * or spend unattended.
 *
 * localStorage is deliberate: the read must be synchronous at mount time and
 * must survive a tab close or browser restart. No DB migration, no await in
 * the abort/unmount path, no secrets. Unreadable storage fails safe — a manual
 * Resume is always available.
 */

const KEY_PREFIX = 'openmaic:generation-intent:';

/** An intent older than this is abandoned, not a live run. */
export const RUN_INTENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Auto-resume attempts allowed per window before the run parks for good. */
export const MAX_AUTO_RESUMES = 3;
/** Resets the auto-resume counter after a quiet period. */
export const AUTO_RESUME_WINDOW_MS = 30 * 60 * 1000;
/** One navigation can mount the classroom twice (StrictMode / workbench). */
const DEDUPE_MS = 30_000;

export type RunIntent = 'active' | 'stopped';

export interface RunIntentRecord {
  intent: RunIntent;
  at: number;
  autoResumes: number;
  windowStartedAt: number;
}

const seen = new Map<string, { at: number; resume: boolean }>();

function storageKey(stageId: string): string {
  return `${KEY_PREFIX}${stageId}`;
}

export function readGenerationIntent(
  stageId: string,
  now: number = Date.now(),
): RunIntentRecord | null {
  if (typeof window === 'undefined' || !stageId) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(stageId));
    if (raw === null) return null;
    const record = JSON.parse(raw) as RunIntentRecord;
    if (
      (record.intent !== 'active' && record.intent !== 'stopped') ||
      !Number.isFinite(record.at) ||
      now - record.at > RUN_INTENT_MAX_AGE_MS
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function write(record: RunIntentRecord, stageId: string): void {
  if (typeof window === 'undefined' || !stageId) return;
  try {
    window.localStorage.setItem(storageKey(stageId), JSON.stringify(record));
  } catch {
    // No storage: the owner can always press Resume.
  }
}

/**
 * Keep a live run's intent fresh. Long semester courses run for days; a
 * heartbeat on each scene prevents the TTL from expiring mid-run while an
 * abandoned run still decays normally. Does not touch the auto-resume budget.
 */
export function touchGenerationIntent(stageId: string, now: number = Date.now()): void {
  if (!stageId) return;
  const record = readGenerationIntent(stageId, now);
  if (record?.intent !== 'active') return;
  write({ ...record, at: now }, stageId);
}

/** Explicit Start / Resume. Resets the auto-resume budget. */
export function markGenerationActive(stageId: string, now: number = Date.now()): void {
  if (!stageId) return;
  write({ intent: 'active', at: now, autoResumes: 0, windowStartedAt: now }, stageId);
  seen.delete(stageId);
}

/** Explicit Pause / Cancel / Stop. Authoritative: no automatic resume. */
export function markGenerationStopped(stageId: string, now: number = Date.now()): void {
  if (!stageId) return;
  write({ intent: 'stopped', at: now, autoResumes: 0, windowStartedAt: now }, stageId);
  seen.delete(stageId);
}

/** A course that settled or was deleted no longer carries any intent. */
export function clearGenerationIntent(stageId: string): void {
  if (typeof window !== 'undefined' && stageId) {
    try {
      window.localStorage.removeItem(storageKey(stageId));
    } catch {
      /* ignore */
    }
  }
  if (stageId) seen.delete(stageId);
}

/**
 * Whether an unfinished course with live `active` intent should restart after
 * an unintentional abort. Call once per classroom mount, only when there is
 * actually pending work. A second call for the same navigation is a no-op.
 */
export function shouldAutoResume(stageId: string, now: number = Date.now()): boolean {
  if (!stageId) return false;
  const recent = seen.get(stageId);
  if (recent && now - recent.at <= DEDUPE_MS) return recent.resume;

  const record = readGenerationIntent(stageId, now);
  let resume = false;
  if (record?.intent === 'active') {
    const freshWindow = now - record.windowStartedAt <= AUTO_RESUME_WINDOW_MS;
    const used = freshWindow ? record.autoResumes : 0;
    if (used >= MAX_AUTO_RESUMES) {
      // Repeated aborts mean something is structurally wrong with this run.
      // Park it instead of trying again on every mount.
      markGenerationStopped(stageId, now);
    } else {
      write(
        {
          intent: 'active',
          at: now,
          autoResumes: used + 1,
          windowStartedAt: freshWindow ? record.windowStartedAt : now,
        },
        stageId,
      );
      resume = true;
    }
  }
  seen.set(stageId, { at: now, resume });
  return resume;
}
