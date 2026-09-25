/**
 * Generation Session Store
 *
 * The full generation session (requirements, extracted document text/images,
 * coverage digest, research context, outlines) routinely exceeds the ~5MB
 * `sessionStorage` quota — a `setItem` on an oversized payload throws and,
 * unwrapped, kills the generation run mid-flight. The session therefore lives
 * in IndexedDB (`MAIC-Database.generationSessions`), which has no practical
 * size limit, while `sessionStorage` carries only a tiny pointer envelope
 * ({ sessionId, stageId? }) across page navigations under the same
 * `generationSession` key the app has always used.
 *
 * Backward compatibility: sessions written before this store existed kept the
 * full JSON payload in `sessionStorage`, and the e2e suite still seeds that
 * shape. Loading falls back to parsing the raw payload when no IndexedDB
 * record exists; the next save migrates it into IndexedDB and shrinks the
 * envelope down to the pointer.
 */

import { db } from './database';
import type {
  GenerationSessionParams,
  GenerationSessionState,
} from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';

const log = createLogger('GenerationSessionStore');

/** sessionStorage key for the pointer envelope (and, historically, the full payload). */
const ENVELOPE_KEY = 'generationSession';
/**
 * Legacy sessionStorage key holding the params handed to the classroom page,
 * written by generation-preview before the session moved into IndexedDB. Read
 * only as a fallback for sessions created by older builds.
 */
const LEGACY_PARAMS_KEY = 'generationParams';

/** Pointer written to sessionStorage so cross-page navigation can find the record. */
export interface GenerationSessionEnvelope {
  sessionId: string;
  stageId?: string;
}

/**
 * Synchronously read the pointer envelope (null when no session is parked).
 * Lets callers branch on `stageId` without touching the raw key themselves.
 */
export function readGenerationSessionEnvelope(): GenerationSessionEnvelope | null {
  return readEnvelope();
}

function readEnvelope(): GenerationSessionEnvelope | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(ENVELOPE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GenerationSessionEnvelope> | null;
    if (!parsed || typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null;
    return {
      sessionId: parsed.sessionId,
      stageId: typeof parsed.stageId === 'string' ? parsed.stageId : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Synchronously check whether a generation session pointer exists — used by
 * the home page's resume prompt and the classroom page's cleanup guard.
 */
export function hasGenerationSessionEnvelope(): boolean {
  return readEnvelope() !== null;
}

/**
 * Load the full generation session: the IndexedDB record when present
 * (authoritative — a superset of anything sessionStorage ever held), else the
 * legacy full payload from sessionStorage. Returns null when no session is
 * parked (or it is unreadable, which the caller treats as "no session").
 */
export async function loadGenerationSession(): Promise<GenerationSessionState | null> {
  const envelope = readEnvelope();
  if (!envelope) return null;

  try {
    const record = await db.generationSessions.get(envelope.sessionId);
    if (record) return record.session;
  } catch (e) {
    log.warn('Failed to read generation session record:', e);
  }

  // Legacy fallback: pre-IndexedDB payload (old tab across an app update, or
  // an e2e seed). Identical key, full session shape.
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(ENVELOPE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GenerationSessionState | null;
    if (!parsed || typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null;
    return parsed;
  } catch (e) {
    log.warn('Failed to parse legacy generation session payload:', e);
    return null;
  }
}

/**
 * Persist the full session to IndexedDB and refresh the pointer envelope.
 *
 * Resolves once the record is durable — awaited wherever a later page depends
 * on the data (home → preview creation, preview → classroom params handoff).
 * Within the running flow, persistSession fires it without awaiting because
 * the in-memory session stays authoritative and every later checkpoint writes
 * a superset.
 */
export async function saveGenerationSession(session: GenerationSessionState): Promise<void> {
  if (!session.sessionId) {
    throw new Error('Cannot save a generation session without a sessionId');
  }

  const now = Date.now();
  try {
    const existing = await db.generationSessions.get(session.sessionId);
    await db.generationSessions.put({
      sessionId: session.sessionId,
      session,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  } catch (e) {
    // IndexedDB is the source of truth for resume; a failed write means the
    // refresh-recovery data is stale. Surface it — callers decide whether the
    // run can continue (in-flight checkpoints) or must fail (pre-navigation).
    throw e instanceof Error ? e : new Error(String(e));
  }

  if (typeof sessionStorage !== 'undefined') {
    const envelope: GenerationSessionEnvelope = { sessionId: session.sessionId };
    if (session.stageId) envelope.stageId = session.stageId;
    try {
      sessionStorage.setItem(ENVELOPE_KEY, JSON.stringify(envelope));
    } catch (e) {
      // The envelope is ~100 bytes; a failure here means storage is blocked
      // entirely (private mode with data APIs off). The run can still finish —
      // only refresh-recovery is degraded — so warn instead of throwing.
      log.warn('Failed to write generation session envelope:', e);
    }
  }
}

/**
 * Remove the session entirely: the pointer envelope plus the IndexedDB record.
 * Best-effort — used at natural session end (course handed off and consumed,
 * or backed out after persist), where a leftover record is only dead weight.
 */
export async function clearGenerationSession(): Promise<void> {
  const envelope = readEnvelope();
  clearGenerationSessionEnvelope();
  if (!envelope) return;
  try {
    await db.generationSessions.delete(envelope.sessionId);
  } catch (e) {
    log.warn('Failed to delete generation session record:', e);
  }
}

/**
 * Remove only the pointer envelope, keeping the IndexedDB record. Used when
 * the session's data must survive the navigation that ends it (the classroom
 * page still reads generationParams from the record after the handoff).
 */
export function clearGenerationSessionEnvelope(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(ENVELOPE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Load the params the generation-preview flow handed to the classroom resume
 * path (agents, media context, language directive).
 *
 * Looked up by the stage id (the classroom URL param), not the sessionStorage
 * envelope: the envelope dies with the tab, while the record — and therefore
 * the resume-after-crash path — must survive it. Falls back to the legacy
 * standalone sessionStorage payload written by older builds.
 */
export async function loadGenerationParams(
  stageId: string,
): Promise<GenerationSessionParams | null> {
  try {
    const records = await db.generationSessions
      .where('session.stageId')
      .equals(stageId)
      .toArray();
    const latest = records.sort((a, b) => a.updatedAt - b.updatedAt).pop();
    if (latest?.session.generationParams) return latest.session.generationParams;
  } catch (e) {
    log.warn('Failed to load generation params from session record:', e);
  }

  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(LEGACY_PARAMS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as GenerationSessionParams;
  } catch (e) {
    log.warn('Failed to parse legacy generationParams payload:', e);
    return null;
  }
}

/**
 * Drop the generation session for a finished handoff: every record whose
 * session belongs to `stageId`, plus the pointer envelope when it points at
 * that stage. The classroom page calls this once the params are consumed (or
 * when a fully materialized deck makes them irrelevant) so nothing is left
 * for the TTL sweep to find.
 */
export async function clearGenerationSessionForStage(stageId: string): Promise<void> {
  if (typeof sessionStorage !== 'undefined') {
    const envelope = readEnvelope();
    if (envelope?.stageId === stageId) clearGenerationSessionEnvelope();
  }
  try {
    await db.generationSessions.where('session.stageId').equals(stageId).delete();
  } catch (e) {
    log.warn('Failed to delete generation session records for stage:', e);
  }
}

/**
 * Delete abandoned session records older than the given age. Sessions that
 * never reached their natural end (tab closed mid-run) would otherwise linger
 * forever. Runs alongside the existing image-blob sweep on the preview page.
 */
export async function cleanupOldGenerationSessions(hoursOld: number = 24): Promise<void> {
  try {
    const cutoff = Date.now() - hoursOld * 60 * 60 * 1000;
    await db.generationSessions.where('updatedAt').below(cutoff).delete();
  } catch (e) {
    log.warn('Failed to clean up old generation sessions:', e);
  }
}
