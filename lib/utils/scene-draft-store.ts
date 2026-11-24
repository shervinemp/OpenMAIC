/**
 * Browser facade for the shared scene-draft cache.
 *
 * Drafts live in one server-side store so a payload pre-warmed by the browser
 * generator can be reused by the detached server runner (and vice versa). The
 * API is best-effort: a cache miss only costs a re-paid LLM call, so every
 * operation swallows failures just like the old IndexedDB implementation did.
 *
 * Only raw content/actions payloads are cached. Gates, semantics, TTS, media
 * and retries still run in full whenever a draft is consumed.
 */

import { createLogger } from '@/lib/logger';
import type { SceneDraft, SceneDraftPayload } from './scene-draft-model';

export { sceneDraftId } from './scene-draft-model';
export type { SceneDraft, SceneDraftPayload } from './scene-draft-model';

const log = createLogger('SceneDraftStore');

async function request(path: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(path, init);
    if (!response.ok) return null;
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  } catch (error) {
    log.warn('Scene draft store unavailable:', error);
    return null;
  }
}

function jsonInit(method: 'POST' | 'DELETE', body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Sweep abandoned drafts across all stages (also happens on every load). */
export async function sweepStaleSceneDrafts(): Promise<void> {
  await request('/api/scene-drafts', { cache: 'no-store' });
}

/** All usable drafts for a stage, keyed by outline id. */
export async function loadSceneDrafts(stageId: string): Promise<Map<string, SceneDraft>> {
  const data = await request(`/api/scene-drafts?stageId=${encodeURIComponent(stageId)}`, {
    cache: 'no-store',
  });
  const drafts = Array.isArray(data?.drafts) ? (data.drafts as SceneDraft[]) : [];
  return new Map(drafts.map((draft) => [draft.outlineId, draft]));
}

/** Store a raw content/actions payload; the server merges and evacuates. */
export async function saveSceneDraft(
  stageId: string,
  outlineId: string,
  payload: SceneDraftPayload,
): Promise<void> {
  await request('/api/scene-drafts', jsonInit('POST', { stageId, outlineId, payload }));
}

/** A scene committed (or failed for good): its raw payload is no longer needed. */
export async function deleteSceneDraft(stageId: string, outlineId: string): Promise<void> {
  await request('/api/scene-drafts', jsonInit('DELETE', { stageId, outlineId }));
}

/** Whole batch finished, or its course was deleted. */
export async function clearSceneDraftsForStage(stageId: string): Promise<void> {
  await request('/api/scene-drafts', jsonInit('DELETE', { stageId }));
}
