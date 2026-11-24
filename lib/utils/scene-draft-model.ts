/**
 * Storage-agnostic model of the scene-draft cache.
 *
 * Drafts are a transport cache of the two raw LLM payloads (content, actions),
 * keyed by a fingerprint of every input that can change them. Gates, semantics,
 * TTS and media still run when a draft is consumed — this is never a bypass.
 * Both the browser generator and the server runner use this same model so a
 * payload written by one engine can be safely reused by the other.
 */

/** Abandoned drafts older than a day are never worth reusing. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The ordered consumer only ever looks a few scenes ahead. Keeping more than
 * this per stage is pure bloat (a live batch overwrites the oldest anyway).
 */
export const MAX_DRAFTS_PER_STAGE = 24;

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

export function isStaleDraft(draft: SceneDraft, now = Date.now()): boolean {
  return now - draft.updatedAt > DRAFT_TTL_MS;
}

/**
 * Merge a partial payload into the existing draft. A changed source key
 * invalidates the other half too, so new content can never be paired with
 * actions generated from old inputs.
 */
export function mergeSceneDraft(
  existing: SceneDraft | undefined,
  stageId: string,
  outlineId: string,
  payload: SceneDraftPayload,
  now = Date.now(),
): SceneDraft {
  const sameSource = existing?.sourceKey === payload.sourceKey;
  const content =
    payload.content !== undefined ? payload.content : sameSource ? existing?.content : undefined;
  const actions =
    payload.actions !== undefined ? payload.actions : sameSource ? existing?.actions : undefined;
  return {
    id: sceneDraftId(stageId, outlineId),
    stageId,
    outlineId,
    sourceKey: payload.sourceKey,
    ...(content !== undefined ? { content } : {}),
    ...(actions !== undefined ? { actions } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

/** Drop stale rows and keep only the newest window of drafts for one stage. */
export function pruneSceneDrafts(drafts: SceneDraft[], now = Date.now()): SceneDraft[] {
  const live = drafts.filter((draft) => !isStaleDraft(draft, now));
  live.sort((a, b) => a.updatedAt - b.updatedAt);
  return live.slice(Math.max(0, live.length - MAX_DRAFTS_PER_STAGE));
}
