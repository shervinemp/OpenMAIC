import { NextRequest } from 'next/server';
import { JsonFileDocumentStore } from '@openmaic/storage/server/file-document-store';
import { GitSyncDocumentStore } from '@/lib/persistence/git-sync-document-store';
import { getCourseGitScheduler } from '@/lib/persistence/git-course-sync';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
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

  const documentStore = new GitSyncDocumentStore(
    new JsonFileDocumentStore({
      dir: fileDir,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }),
    getCourseGitScheduler(fileDir),
  );

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
    // Red/green doctrine: current validator truth wins over history — a
    // written-off scene whose errors re-emerge goes back on the list.
    if (errors > 0 || (ledger && ledger.errors > 0)) {
      flagged.push({
        sceneId: scene.id,
        order: scene.order,
        title: scene.title ?? '',
        errors: Math.max(errors, ledger?.errors ?? 0),
        warnings: Math.max(warnings, ledger?.warnings ?? 0),
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
