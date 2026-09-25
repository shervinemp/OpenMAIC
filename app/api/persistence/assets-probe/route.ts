import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { authenticatePersistenceHeaders } from '@/lib/persistence/server-auth';

/**
 * POST /api/persistence/assets-probe — batched asset presence probe.
 *
 * Body: { refs: string[] } → { present: Record<string, boolean> }
 *
 * One batched oracle request replaces N per-ref GETs at detection/audit
 * time (a 600-page course's backfill/diff flow would otherwise issue
 * thousands of sequential round-trips). Presence = the encoded ref has
 * non-empty bytes under `PERSISTENCE_DIR/assets` — the same notion the
 * per-ref asset GET route resolves.
 *
 * Pure read, bounded: 500 refs max per call (the client chunks).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROBE_MAX = 500;

export async function POST(request: Request): Promise<Response> {
  const dir = process.env.PERSISTENCE_DIR?.trim();
  if (!dir) {
    return Response.json(
      { error: { code: 'PERSISTENCE_UNAVAILABLE', message: 'PERSISTENCE_DIR is not configured' } },
      { status: 503 },
    );
  }
  if (!(await authenticatePersistenceHeaders(request.headers))) {
    return Response.json(
      { error: { code: 'UNAUTHENTICATED', message: 'server persistence requires authentication' } },
      { status: 401 },
    );
  }
  let body: { refs?: unknown };
  try {
    body = (await request.json()) as { refs?: unknown };
  } catch {
    return Response.json(
      { error: { code: 'INVALID_BODY', message: 'request body must be JSON' } },
      { status: 400 },
    );
  }
  const refs = Array.isArray(body.refs)
    ? body.refs.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
    : [];
  if (refs.length === 0) return Response.json({ present: {} });
  if (refs.length > PROBE_MAX) {
    return Response.json(
      {
        error: {
          code: 'BATCH_TOO_LARGE',
          message: `probe is capped at ${PROBE_MAX} refs per call`,
        },
      },
      { status: 413 },
    );
  }

  const assetsDir = join(dir, 'assets');
  const present: Record<string, boolean> = {};
  for (const ref of refs) {
    const bytesPath = join(assetsDir, encodeURIComponent(ref));
    try {
      present[ref] = existsSync(bytesPath) && statSync(bytesPath).size > 0;
    } catch {
      present[ref] = false;
    }
  }
  return Response.json({ present });
}
