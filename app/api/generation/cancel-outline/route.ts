import { promises as fs } from 'node:fs';
import path from 'node:path';

import { apiError, apiSuccess } from '@/lib/server/api-response';

export const runtime = 'nodejs';

/**
 * Pause an outline pass started by the course-creation helper. The helper
 * checks for this marker between SSE frames and stops before creating scenes;
 * the partial course document stays on disk so it can be resumed or deleted.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { stageId?: unknown };
  const stageId = typeof body.stageId === 'string' ? body.stageId : '';
  if (!/^[A-Za-z0-9_-]+$/.test(stageId)) {
    return apiError('INVALID_REQUEST', 400, 'A valid stageId is required');
  }
  try {
    const dir = path.join(process.cwd(), 'data', 'course-creation');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${stageId}.cancel`), new Date().toISOString(), 'utf8');
    return apiSuccess({ cancelled: true, stageId });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Could not cancel outline generation',
      error instanceof Error ? error.message : String(error),
    );
  }
}
