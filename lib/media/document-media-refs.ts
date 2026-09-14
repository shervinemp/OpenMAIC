/**
 * Media refs inside a persisted course document.
 *
 * Pure walk (no node imports): shared between the server-side repo snapshot
 * (git-sync-assets.ts) and the browser-side backfill uploader
 * (backfill-course-media.ts), so "which refs does the course reference" is
 * defined exactly once.
 *
 * Keys carry meaning, and callers need different classes of that meaning:
 *
 *   - `src` — bytes-bearing refs (images, videos, posters, covers): the
 *     renderer resolves these, so byte-detection paths probe them.
 *   - `audioId` / `audioRef` — narration ids: probe through the audio path.
 *   - `elementId` — EITHER a canvas element id (no bytes anywhere — the
 *     renderer never resolves it as media) OR a generation-time task ref
 *     (`gen_img_1`, `gen_vid_2`) whose bytes live in the media store under
 *     `stageId:elementId`. The generation-time snapshot and the backfill
 *     uploader include these; byte-detection paths must NOT probe them
 *     directly — that class is owned by the media orchestrator's own
 *     byte-aware requeue (see repair-course-media.ts).
 */

/** Keys that name bytes the renderer itself resolves at play time. */
const RENDERED_MEDIA_KEYS = new Set(['src', 'audioId', 'audioRef']);

function refIsMediaCandidate(value: string): boolean {
  if (/^\/assets\//.test(value)) {
    // Scene elements sometimes carry the pool URL path rather than the raw
    // ref: strip it, the effective ref is the last segment.
    return /^[A-Za-z0-9_.-]+$/.test(decodeURIComponent(value.slice('/assets/'.length)));
  }
  return (
    /^[A-Za-z0-9_.-]+$/.test(value) &&
    !value.startsWith('data:') &&
    !/^https?:/.test(value) &&
    !/^[A-Za-z]:[\\/]/.test(value)
  );
}

function normalizeRef(value: string): string {
  return value.startsWith('/assets/')
    ? decodeURIComponent(value.slice('/assets/'.length))
    : value;
}

export interface CollectMediaRefsOptions {
  /**
   * Include `elementId` refs (generation-time task refs). Default: true —
   * the snapshot/backfill contract. Byte-detection paths pass false.
   */
  readonly includeElementIdRefs?: boolean;
}

/** Every media ref the document references. Opaque-walk, no DSL knowledge. */
export function collectDocumentMediaRefs(
  document: unknown,
  options: CollectMediaRefsOptions = {},
): string[] {
  const includeElementIds = options.includeElementIdRefs !== false;
  const refs = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child);
        const isCandidateKey =
          RENDERED_MEDIA_KEYS.has(key) || (includeElementIds && key === 'elementId');
        if (isCandidateKey && typeof child === 'string' && refIsMediaCandidate(child)) {
          refs.add(normalizeRef(child));
        }
      }
    }
  };
  visit(document);
  return [...refs];
}
