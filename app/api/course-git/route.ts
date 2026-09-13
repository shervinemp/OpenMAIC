import { authenticatePersistenceRequest } from '@/lib/persistence/server-auth';

import {
  bindCourseRepository,
  CourseRepositoryAlreadyBoundError,
  getCourseBinding,
  listCourseBindings,
  unbindCourseRepository,
} from '@/lib/persistence/git-course-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function persistenceDir(): string | null {
  const dir = process.env.PERSISTENCE_DIR?.trim();
  return dir ? dir : null;
}

export async function GET(request: Request): Promise<Response> {
  const dir = persistenceDir();
  if (!dir) return jsonError(503, 'GIT_SYNC_UNAVAILABLE', 'PERSISTENCE_DIR is not configured');
  if (!(await authenticatePersistenceRequest(request))) {
    return jsonError(401, 'UNAUTHENTICATED', 'server persistence requires authentication');
  }
  const stageId = new URL(request.url).searchParams.get('stageId');
  if (stageId) {
    const binding = await getCourseBinding(dir, stageId);
    return Response.json({ binding: binding ? { ...binding } : null });
  }
  const bindings = await listCourseBindings(dir);
  return Response.json({ bindings });
}

interface BindBody {
  stageId?: string;
  repoPath?: string;
  init?: boolean;
}

export async function POST(request: Request): Promise<Response> {
  const dir = persistenceDir();
  if (!dir) return jsonError(503, 'GIT_SYNC_UNAVAILABLE', 'PERSISTENCE_DIR is not configured');
  if (!(await authenticatePersistenceRequest(request))) {
    return jsonError(401, 'UNAUTHENTICATED', 'server persistence requires authentication');
  }
  let body: BindBody;
  try {
    body = (await request.json()) as BindBody;
  } catch {
    return jsonError(400, 'INVALID_BODY', 'request body must be JSON');
  }
  const { stageId, repoPath, init } = body;
  if (!stageId || typeof stageId !== 'string') {
    return jsonError(400, 'INVALID_STAGE_ID', 'stageId is required');
  }
  if (!repoPath || typeof repoPath !== 'string' || repoPath.trim() === '') {
    return jsonError(400, 'INVALID_REPO_PATH', 'repoPath is required');
  }
  try {
    const binding = await bindCourseRepository({ persistenceDir: dir, stageId, repoPath, init });
    return Response.json({ binding: { ...binding } });
  } catch (error) {
    if (error instanceof CourseRepositoryAlreadyBoundError) {
      return jsonError(409, 'ALREADY_BOUND', error.message);
    }
    const message = error instanceof Error ? error.message : 'binding failed';
    return jsonError(400, 'BIND_FAILED', message);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const dir = persistenceDir();
  if (!dir) return jsonError(503, 'GIT_SYNC_UNAVAILABLE', 'PERSISTENCE_DIR is not configured');
  if (!(await authenticatePersistenceRequest(request))) {
    return jsonError(401, 'UNAUTHENTICATED', 'server persistence requires authentication');
  }
  const stageId = new URL(request.url).searchParams.get('stageId');
  if (!stageId) return jsonError(400, 'INVALID_STAGE_ID', 'stageId is required');
  const removed = await unbindCourseRepository(dir, stageId);
  return Response.json({ removed });
}
