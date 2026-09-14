import { db } from '@/lib/utils/database';
import { isConcreteMediaAddress } from './resolve-media-ref';
import { withAssetUrl } from './use-asset-url';

/**
 * Bytes an audio reference currently resolves to.
 *
 * A stable-id regeneration commits the replaced narration to the pool first and
 * deliberately keeps the same id; if the `audioFiles` mirror write then fails
 * (quota pressure, a transient IndexedDB error) the row is stale while the pool
 * is current. Every consumer of allocated audio therefore resolves through this
 * one function, with Dexie kept as the fallback for legacy and imported rows
 * that were never pool-backed.
 */
export async function resolveAudioBlob(audioId: string): Promise<Blob | null> {
  const pooled = await pooledAudioBlob(audioId);
  if (pooled) return pooled;
  const record = await db.audioFiles.get(audioId);
  const bytes = record?.blob;
  // Zero-byte rows (evicted, or an empty fetch) are not playable narration:
  // report no bytes so callers keep the reference retryable instead of
  // playing silence.
  if (bytes && bytes.size > 0) return bytes;
  // SERVER FALLBACK (cross-device/cross-tab single source of truth): with
  // server persistence configured, the library also carries narration bytes
  // (uploaded at generation time or by a backfill). A local miss is not
  // "dead" — hydrate from the server, return the bytes; the local mirror is
  // seeded inside the fetch helper (quota-tolerant, failure non-fatal).
  const fetched = await fetchServerAudioBlob(audioId);
  return fetched ?? null;
}

const inFlightServerLookup = new Map<string, Promise<Blob | null>>();

async function fetchServerAudioBlob(audioId: string): Promise<Blob | null> {
  if (!audioId || isConcreteMediaAddress(audioId)) return null;
  const pending = inFlightServerLookup.get(audioId);
  if (pending) return pending;
  const promise = (async () => {
    try {
      const { isBrowserPersistenceEnabled, getPersistenceRequestHeaders } = await import(
        '@/lib/persistence/bootstrap'
      );
      if (!isBrowserPersistenceEnabled()) return null;
      const headers = await getPersistenceRequestHeaders();
      const response = await fetch(`/api/persistence/assets/${encodeURIComponent(audioId)}`, {
        headers,
      });
      if (!response.ok) return null;
      const blob = await response.blob();
      if (!blob || blob.size === 0) return null;
      // Seed the local mirror: future plays resolve locally (quota pressure
      // tolerant — a failed mirror write falls back to per-play server fetch,
      // which the next call re-hydrates).
      const mime = response.headers.get('content-type') || blob.type;
      const seeded: Blob = mime ? blob : blob;
      try {
        await db.audioFiles.put({
          id: audioId,
          stageId: undefined,
          blob: seeded,
          duration: undefined,
          format: mime.replace('audio/', '') || 'wav',
          text: '',
          voice: '',
          createdAt: Date.now(),
        });
      } catch {
        // Quota/full mirror is non-fatal: bytes were returned to the caller.
      }
      return seeded;
    } catch {
      return null;
    } finally {
      inFlightServerLookup.delete(audioId);
    }
  })();
  inFlightServerLookup.set(audioId, promise);
  return promise;
}

/** Resolve several ids at once, preserving input order. */
export async function resolveAudioBlobs(
  audioIds: readonly string[],
): Promise<ReadonlyArray<Blob | null>> {
  return Promise.all(audioIds.map((audioId) => resolveAudioBlob(audioId)));
}

async function pooledAudioBlob(audioId: string): Promise<Blob | null> {
  if (!audioId || isConcreteMediaAddress(audioId)) return null;
  try {
    return await withAssetUrl(audioId, async (url) => {
      if (!url) return null;
      const response = await fetch(url);
      const blob = response.ok ? await response.blob() : null;
      return blob && blob.size > 0 ? blob : null;
    });
  } catch {
    // Stored rows stay the fallback when the pool is unavailable.
    return null;
  }
}
