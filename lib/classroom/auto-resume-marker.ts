/**
 * Whether opening a classroom may start generation by itself.
 *
 * Resuming an unfinished deck spends the owner's provider budget, so a course
 * that is merely OPENED waits behind its Resume button. The one exception is
 * the hand-off from generation-preview: the owner has just pressed Start (or
 * Resume from the home page), and the classroom is where the remaining scenes
 * are produced. The preview leaves a short-lived marker in the tab's
 * sessionStorage; the classroom takes it exactly once. A cold open, a reload
 * or another tab finds none and stays paused.
 *
 * Unreadable storage (private mode, blocked site data) means no marker, i.e.
 * the safe side: the owner presses the button.
 */

const MARKER_PREFIX = 'openmaic:auto-resume:';

/** A hand-off is a navigation: seconds. This only guards against a stale key. */
export const AUTO_RESUME_MARKER_MAX_AGE_MS = 5 * 60_000;

/**
 * Hand-offs taken in this page load, by stage. The surface can mount twice for
 * one navigation (the standalone page and the workbench pane, a remount), and
 * the second mount must not read "no marker" and undo a resume the owner asked
 * for. Short-lived on purpose: reopening the course later finds nothing here.
 */
const RECENT_HANDOFF_MS = 30_000;
const taken = new Map<string, number>();

export function markAutoResume(stageId: string, now: number = Date.now()): void {
  try {
    window.sessionStorage.setItem(`${MARKER_PREFIX}${stageId}`, String(now));
  } catch {
    // No storage: the classroom will wait for the button.
  }
}

/** True for a hand-off; the marker is removed as it is read. */
export function consumeAutoResume(stageId: string, now: number = Date.now()): boolean {
  const takenAt = taken.get(stageId);
  if (takenAt !== undefined && now - takenAt <= RECENT_HANDOFF_MS) return true;
  try {
    const key = `${MARKER_PREFIX}${stageId}`;
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return false;
    window.sessionStorage.removeItem(key);
    const markedAt = Number(raw);
    const fresh = Number.isFinite(markedAt) && now - markedAt <= AUTO_RESUME_MARKER_MAX_AGE_MS;
    if (fresh) taken.set(stageId, now);
    return fresh;
  } catch {
    return false;
  }
}
