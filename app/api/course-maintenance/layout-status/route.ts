import { NextRequest } from 'next/server';
import { createCourseDocumentStore } from '@/lib/persistence/course-document-store';
import { layoutLedgerOf, residualFindings } from '@/lib/maintenance/layout-relayout';
import { apiError, apiSuccess } from '@/lib/server/api-response';

interface FlaggedScene {
  sceneId: string;
  order: number;
  title: string;
  errors: number;
  warnings: number;
  /** Ledger state from the last maintenance pass, when one ran. */
  ledger?: { errors: number; warnings: number; checkedAt: number };
}

/**
 * Deterministic, token-free layout-debt ledger readout. No vector oracle and
 * no LLM: the placement validator alone decides which scenes stay on the
 * debt list (red/green doctrine — findings, not fixes).
 */
export async function GET(req: NextRequest) {
  const token = process.env.PERSISTENCE_DEV_TOKEN;
  const authorization = req.headers.get('authorization');
  if (!token || !authorization || authorization !== `Bearer ${token}`) {
    return apiError('UNAUTHENTICATED', 401, 'maintenance route requires the dev persistence token');
  }
  const fileDir = process.env.PERSISTENCE_DIR;
  if (!fileDir) {
    return apiError('INVALID_REQUEST', 503, 'this route requires the file-backed persistence backend (PERSISTENCE_DIR)');
  }
  const courseId = req.nextUrl.searchParams.get('courseId')?.trim();
  if (!courseId) return apiError('INVALID_REQUEST', 400, 'courseId is required');

  const documentStore = createCourseDocumentStore(fileDir);

  let document;
  try {
    document = await documentStore.loadDocument(courseId);
  } catch (error) {
    console.error('[layout-status] load failed', error);
    return apiError('UPSTREAM_ERROR', 500, 'course load failed');
  }
  if (!document) return apiError('INVALID_REQUEST', 404, 'course document not found');

  const flagged: FlaggedScene[] = [];
  let ledgerGreen = 0;
  const slideScenes = document.scenes.filter((scene: { type?: string }) => scene.type === 'slide');

  for (const scene of slideScenes) {
    const findings = residualFindings(scene);
    const errors = findings.filter((f) => f.severity === 'error').length;
    const warnings = findings.filter((f) => f.severity === 'warn').length;
    const ledger = layoutLedgerOf(scene);
    if (ledger && ledger.errors === 0) ledgerGreen += 1;
    // Red/green doctrine: CURRENT validator truth decides debt. History is
    // display metadata — a written-off scene is not re-flagged because its
    // old tag cried wolf, and a never-ledgered scene IS flagged when the
    // validator finds errors now.
    if (errors > 0) {
      flagged.push({
        sceneId: scene.id,
        order: scene.order,
        title: scene.title ?? '',
        errors,
        warnings,
        ledger: ledger ?? undefined,
      });
    }
  }
  flagged.sort((a, b) => a.order - b.order);

  return apiSuccess({
    courseId,
    slideScenes: slideScenes.length,
    ledgerGreen,
    debtScenes: flagged.length,
    totalErrors: flagged.reduce((sum, entry) => sum + entry.errors, 0),
    totalWarnings: flagged.reduce((sum, entry) => sum + entry.warnings, 0),
    flagged,
  });
}
