'use client';

import { getPersistenceRequestHeaders } from '@/lib/persistence/bootstrap';

/**
 * The asset ORACLE — one batched, shared source of "does the server hold
 * the bytes for this ref right now".
 *
 * Everything that asks the same question must ask IT: mount-time repair
 * detection, the browser→server backfill's skip-existing pass, the git
 * binding dialog's materialization report, and the repo snapshot audit. A
 * per-ref GET (the previous shape) cost one round-trip per ref — 3,000+
 * sequential fetches on a 600-page course; the oracle chunks the same set
 * into batched POSTs and returns a Map with a stable contract:
 *
 *   resolvable ← key exists and maps to true
 *   unresolved ← key exists and maps to false
 *   unknown    ← missing key (not probed this call — chunking)
 *
 * Server unreachable ⇒ EVERY probed ref reads unresolved (never a silent
 * "everything is there"): probing is a read, callers decide what a miss
 * means for them.
 */

const PROBE_BATCH_SIZE = 500;

export interface AssetProbeRequest {
  refs: readonly string[];
}

export type AssetProbeResult = Map<string, boolean>;

export async function probeServerAssetPresence(
  refs: readonly string[],
): Promise<AssetProbeResult> {
  const result: AssetProbeResult = new Map();
  const unique = [...new Set(refs.filter((ref) => ref.length > 0))];
  if (unique.length === 0) return result;

  const headers = await getPersistenceRequestHeaders();
  for (let cursor = 0; cursor < unique.length; cursor += PROBE_BATCH_SIZE) {
    const batch = unique.slice(cursor, cursor + PROBE_BATCH_SIZE);
    try {
      const response = await fetch('/api/persistence/assets-probe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ refs: batch } satisfies AssetProbeRequest),
      });
      if (!response.ok) {
        // Unreachable/unauthorized server: report NOTHING as present.
        for (const ref of batch) result.set(ref, false);
        continue;
      }
      const data = (await response.json()) as { present?: Record<string, boolean> };
      const present = data.present ?? {};
      for (const ref of batch) result.set(ref, present[ref] === true);
    } catch {
      // Network failure: same bias — dead, retryable.
      for (const ref of batch) result.set(ref, false);
    }
  }
  return result;
}

/**
 * Local-first split for byte detection: a ref resolvable in THIS browser
 * never needs the server probe. Narration reads the audioFiles mirror and
 * the pool directly; generated-media reads the Dexie compat row.
 */
export async function probeLocalAssetPresence(
  ref: string,
  stageId: string | undefined,
): Promise<boolean | 'unknown'> {
  try {
    if (/^(tts_|audio_|speech_)/.test(ref)) {
      const { db } = await import('@/lib/utils/database');
      const row = await db
        .audioFiles.get(ref)
        .catch(() => undefined);
      if (row?.blob && row.blob.size > 0) return true;
      return false;
    }
    if (!stageId) return false;
    const { db, mediaFileKey } = await import('@/lib/utils/database');
    const row = await db.mediaFiles
      .get(mediaFileKey(stageId, ref))
      .catch(() => undefined);
    return !!row && (row.size ?? 0) > 0;
  } catch {
    return false;
  }
}
