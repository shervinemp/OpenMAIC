/**
 * Durable raw drafts for scene content/actions.
 *
 * A parallel batch pre-warms content and actions for many outlines, but commits
 * scenes in order. Until now a cancelled run threw away every pre-warmed result
 * that the ordered loop had not reached yet, so resume re-paid all of them.
 * These drafts hold ONLY the two raw LLM payloads, keyed by a source
 * fingerprint. Gates, semantics, TTS, media and retries still run in full when
 * a draft is consumed — this is a transport cache, not a bypass.
 *
 * Evacuation is built in: a draft is deleted as soon as its scene commits, the
 * whole stage is cleared on completion or course deletion, the store keeps only
 * a small rolling window per stage, and a TTL sweep removes abandoned drafts.
 */

import { db } from './database';
import { createLogger } from '@/lib/logger';

const log = createLogger('SceneDraftStore');

/** Abandoned drafts older than a day are never worth reusing. */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * The ordered consumer only ever looks a few scenes ahead. Keeping more than
 * this per stage is pure bloat (a live batch overwrites the oldest anyway).
 */
const MAX_DRAFTS_PER_STAGE = 24;

export function sceneDraftId(stageId: string, outlineId: string): string {
  return `${stageId}::${outlineId}`;
}

export interface SceneDraftPayload {
  /** Canonical JSON of every input that can change content or actions. */
  sourceKey: string;
  content?: unknown;
  actions?: unknown;
}

export interface SceneDraft extends SceneDraftPayload {
  id: string;
  stageId: string;
  outlineId: string;
  createdAt: number;
  updatedAt: number;
}

/** Sweep abandoned drafts across all stages. Called at the start of a batch. */
export async function sweepStaleSceneDrafts(): Promise<void> {
  try {
    const stale = await db.sceneDrafts.where('updatedAt').below(Date.now() - DRAFT_TTL_MS).toArray();
    if (stale.length > 0) await db.sceneDrafts.bulkDelete(stale.map((row) => row.id));
  } catch (error) {
    log.warn('Failed to sweep stale scene drafts:', error);
  }
}

/**
 * All usable drafts for a stage, keyed by outline id. Stale rows are removed
 * globally here so a batch start is the single sweep point.
 */
export async function loadSceneDrafts(stageId: string): Promise<Map<string, SceneDraft>> {
  await sweepStaleSceneDrafts();
  try {
    const rows = await db.sceneDrafts.where('stageId').equals(stageId).toArray();
    return new Map(rows.map((row) => [row.outlineId, row]));
  } catch (error) {
    log.warn('Failed to load scene drafts:', error);
    return new Map();
  }
}

/**
 * Store a completed payload, merging into any existing draft for the outline.
 * Keeps `content` from being clobbered by a later `actions`-only write.
 */
export async function saveSceneDraft(
  stageId: string,
  outlineId: string,
  payload: SceneDraftPayload,
): Promise<void> {
  try {
    const id = sceneDraftId(stageId, outlineId);
    const now = Date.now();
    const existing = await db.sceneDrafts.get(id);
    // A changed source key invalidates the OTHER half of the draft too. Without
    // this, new content could be paired with actions generated from old inputs.
    const sameSource = existing?.sourceKey === payload.sourceKey;
    const content =
      payload.content !== undefined ? payload.content : sameSource ? existing?.content : undefined;
    const actions =
      payload.actions !== undefined ? payload.actions : sameSource ? existing?.actions : undefined;
    await db.sceneDrafts.put({
      id,
      stageId,
      outlineId,
      sourceKey: payload.sourceKey,
      ...(content !== undefined ? { content } : {}),
      ...(actions !== undefined ? { actions } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    // Rolling-window evacuation: the consumer only needs the few scenes just
    // ahead of it, so trim anything older than the cap.
    const owned = await db.sceneDrafts.where('stageId').equals(stageId).sortBy('updatedAt');
    if (owned.length > MAX_DRAFTS_PER_STAGE) {
      await db.sceneDrafts.bulkDelete(
        owned.slice(0, owned.length - MAX_DRAFTS_PER_STAGE).map((row) => row.id),
      );
    }
  } catch (error) {
    // A cache miss only costs a re-paid LLM call — never fail generation on it.
    log.warn('Failed to save scene draft:', error);
  }
}

/** A scene committed (or failed for good): its raw payload is no longer needed. */
export async function deleteSceneDraft(stageId: string, outlineId: string): Promise<void> {
  try {
    await db.sceneDrafts.delete(sceneDraftId(stageId, outlineId));
  } catch (error) {
    log.warn('Failed to delete scene draft:', error);
  }
}

/** Whole batch finished, or its course was deleted. */
export async function clearSceneDraftsForStage(stageId: string): Promise<void> {
  try {
    await db.sceneDrafts.where('stageId').equals(stageId).delete();
  } catch (error) {
    log.warn('Failed to clear scene drafts:', error);
  }
}
