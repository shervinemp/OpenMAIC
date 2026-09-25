import { authenticatePersistenceHeaders } from '@/lib/persistence/server-auth';

import { runCourseGitSync } from '@/lib/persistence/git-course-import';
import { appendCourseHistory } from '@/lib/persistence/course-history-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

interface SyncApplyBody {
  /** Apply repo-snapshot updates over the persisted course. */
  apply?: boolean;
  /** Import new repo courses whose binding has autoLoad enabled. */
  importNew?: boolean;
  /** Restrict the run to specific stage ids (approval granularity). */
  stageIds?: string[];
}

/**
 * POST /api/course-git/sync — the approval confluence for inbound git sync.
 * GET /api/course-git?sync=true surfaces WHAT would change; this endpoint
 * consumes an explicit approval, and the audit log records exactly what was
 * applied (by which env options) for the "approve to update" paper trail.
 */
export async function POST(request: Request): Promise<Response> {
  const dir = process.env.PERSISTENCE_DIR?.trim();
  if (!dir) return jsonError(503, 'GIT_SYNC_UNAVAILABLE', 'PERSISTENCE_DIR is not configured');
  if (!(await authenticatePersistenceHeaders(request.headers))) {
    return jsonError(401, 'UNAUTHENTICATED', 'server persistence requires authentication');
  }
  let body: SyncApplyBody;
  try {
    body = (await request.json()) as SyncApplyBody;
  } catch {
    return jsonError(400, 'INVALID_BODY', 'request body must be JSON');
  }
  const apply = !!body.apply;
  const importNew = !!body.importNew;
  const stageIds = body.stageIds?.filter((id) => typeof id === 'string');

  const { results } = await runCourseGitSync(dir, { apply, importNew, pull: true });
  const filtered = stageIds?.length
    ? results.filter((result) => stageIds.includes(result.stageId))
    : results;

  appendCourseHistory(dir, 'course-git-sync', { apply, importNew, results: filtered });

  return Response.json({ results: filtered });
}
