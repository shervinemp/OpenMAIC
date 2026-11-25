import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { isMaintenanceUnauthorized } from '@/lib/server/maintenance-auth';
import { auditScenesSample } from '@/lib/maintenance/sample-audit';

export const runtime = 'nodejs';

/**
 * Statistical QA sample of one course (or all file-backed courses). The same
 * audit runs at generation-job completion; this endpoint exposes it on demand
 * so a course can be re-checked after repairs without changing data.
 */
export async function GET(request: Request): Promise<Response> {
  if (isMaintenanceUnauthorized(request)) return apiError('UNAUTHENTICATED', 401, 'Unauthorized');
  const dir = process.env.PERSISTENCE_DIR;
  if (!dir) return apiError('INVALID_REQUEST', 400, 'Only the file-backed store is supported');

  const wanted = new URL(request.url).searchParams.get('courseId')?.trim() ?? '';
  if (wanted && !/^[A-Za-z0-9_-]+$/.test(wanted)) {
    return apiError('INVALID_REQUEST', 400, 'Invalid courseId');
  }

  try {
    const { JsonFileDocumentStore } = await import('@openmaic/storage/server/file-document-store');
    const store = new JsonFileDocumentStore({
      dir,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    const files = (await readdir(join(dir, 'documents'))).filter(
      (file) => file.endsWith('.json') && !file.includes('.tmp-'),
    );
    const courses: Array<{ courseId: string; report: ReturnType<typeof auditScenesSample> | null }> = [];
    for (const file of files) {
      const courseId = file.slice(0, -'.json'.length);
      if (wanted && courseId !== wanted) continue;
      const document = await store.loadDocument(courseId);
      courses.push({
        courseId,
        report: document ? auditScenesSample(document as never, courseId) : null,
      });
    }

    const totals = courses.reduce(
      (acc, entry) => {
        if (!entry.report) return acc;
        acc.population += entry.report.population;
        acc.sampleSize += entry.report.sampleSize;
        acc.layout += entry.report.summary.layout;
        acc.cjk += entry.report.summary.cjk;
        acc.source += entry.report.summary.source;
        acc.faulty += entry.report.findings.length;
        return acc;
      },
      { population: 0, sampleSize: 0, layout: 0, cjk: 0, source: 0, faulty: 0 },
    );

    return apiSuccess({ courses, totals });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Sample audit failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}
