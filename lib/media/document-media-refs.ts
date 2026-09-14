/**
 * Media refs inside a persisted course document.
 *
 * Pure walk (no node imports): shared between the server-side repo snapshot
 * (git-sync-assets.ts) and the browser-side backfill uploader
 * (backfill-course-media.ts), so "which refs does the course reference" is
 * defined exactly once.
 */

const MEDIA_REF_KEYS = new Set(['src', 'audioId', 'audioRef', 'elementId']);

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

/** Every media ref the document references. Opaque-walk, no DSL knowledge. */
export function collectDocumentMediaRefs(document: unknown): string[] {
  const refs = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child);
        if (MEDIA_REF_KEYS.has(key) && typeof child === 'string' && refIsMediaCandidate(child)) {
          refs.add(normalizeRef(child));
        }
      }
    }
  };
  visit(document);
  return [...refs];
}
