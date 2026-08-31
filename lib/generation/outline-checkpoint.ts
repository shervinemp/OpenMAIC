/**
 * Durable outline checkpoint (§16 recovery), shared by the generation-preview
 * flow (writer) and the home submit (adoption on retry).
 *
 * The checkpoint is keyed by sessionId and stored in the device KV so a tab
 * close or browser restart does not lose partial multi-unit progress. The
 * originating requirement is stamped on the record so a RETRY (which creates
 * a new session id) can adopt the checkpoint instead of orphaning it - the
 * #1 recovery hole: without adoption, "Go Back and Retry" after a mid-course
 * failure silently discarded every completed unit.
 */
import { BrowserKVStore } from '@openmaic/storage';

export const OUTLINE_CHECKPOINT_KEY = 'outlineCheckpoint';

export interface OutlineCheckpoint {
  sessionId: string;
  syllabus: unknown;
  outlines: unknown[];
  completedUnitCount: number;
  /** The requirement this checkpoint belongs to (adoption match on retry). */
  requirement?: string;
}export function outlineCheckpointStore(): BrowserKVStore {
  return new BrowserKVStore();
}

export async function readOutlineCheckpoint(): Promise<OutlineCheckpoint | null> {
  try {
    return await outlineCheckpointStore().get<OutlineCheckpoint>(
      OUTLINE_CHECKPOINT_KEY,
      'device',
    );
  } catch {
    return null;
  }
}

export async function writeOutlineCheckpoint(checkpoint: OutlineCheckpoint): Promise<void> {
  await outlineCheckpointStore().set(OUTLINE_CHECKPOINT_KEY, checkpoint, 'device');
}

export async function clearOutlineCheckpoint(): Promise<void> {
  await outlineCheckpointStore().remove(OUTLINE_CHECKPOINT_KEY, 'device');
}

/**
 * Adopt an existing checkpoint when the user resubmits the SAME requirement:
 * the new session reuses the checkpoint's sessionId so the generation
 * preview's resume path (matched by sessionId) engages. Returns the sessionId
 * to use, or undefined when there is nothing to adopt.
 */
export async function adoptCheckpointSessionId(
  requirement: string,
  sessionIdFor: (checkpoint: OutlineCheckpoint) => string | undefined,
): Promise<string | undefined> {
  try {
    const checkpoint = await readOutlineCheckpoint();
    if (
      checkpoint &&
      checkpoint.completedUnitCount > 0 &&
      typeof checkpoint.requirement === 'string' &&
      checkpoint.requirement.trim() === requirement.trim()
    ) {
      return sessionIdFor(checkpoint);
    }
  } catch {
    // Checkpoint unreadable: a fresh session is always safe.
  }
  return undefined;
}
