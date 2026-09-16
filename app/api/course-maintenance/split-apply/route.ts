import { NextRequest } from 'next/server';
import { JsonFileDocumentStore } from '@openmaic/storage/server/file-document-store';
import { GitSyncDocumentStore } from '@/lib/persistence/git-sync-document-store';
import { getCourseGitScheduler } from '@/lib/persistence/git-course-sync';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import {
  applySplit,
  type SplitApplyDocumentShape,
  type SplitApplyResult,
} from '@/lib/maintenance/split-apply';
import { layoutLedgerOf, residualFindings } from '@/lib/maintenance/layout-relayout';
import { apiError, apiSuccess } from '@/lib/server/api-response';

/**
 * The self-healing terminal for layout debt: splits the ledgered debt scenes
 * across multiple canvases (verbatim rows, anchored action rides) in ONE
 * atomic saveDocument pass. No LLM, no tokens, no manual gate — invoked by
 * the on-load pipeline after the deterministic pass and the bounded patch
 * pass cannot cure a scene.
 *
 * Safety: only scenes the validator still flags get split. A scene whose
 * ledger is clean or whose plan collapses into one chunk is skipped, so a
 * bitter repair can't split healthy or red-carded content.
 */
export async function POST(req: NextRequest) {
  const unauthorized = await isUnauthorized(req);
  if (unauthorized) {
    return apiError('UNAUTHENTICATED', 401, 'maintenance route requires the dev persistence token');
  }
  const fileDir = process.env.PERSISTENCE_DIR;
  if (!fileDir) {
    return apiError('INVALID_REQUEST', 503, 'this route requires the file-backed persistence backend (PERSISTENCE_DIR)');
  }
  let body: { courseId?: string; sceneIds?: string[] };
  try {
    body = (await req.json()) as { courseId?: string; sceneIds?: string[] };
  } catch {
    return apiError('INVALID_REQUEST', 400, 'body must be JSON');
  }
  const courseId = body.courseId?.trim();
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
    console.error('[split-apply] load failed', error);
    return apiError('UPSTREAM_ERROR', 500, 'course load failed');
  }
  if (!document) return apiError('INVALID_REQUEST', 404, 'course document not found');

  const requested = body.sceneIds?.length ? body.sceneIds : null;
  const targets = (document.scenes as unknown as Array<Record<string, unknown>>).filter(
    (scene) => scene.type === 'slide' && (!requested || requested.includes(String(scene.id))),
  ).map((scene) => ({
    scene,
    errors: residualFindings(scene as never).filter((f) => f.severity === 'error').length,
    ledgered: layoutLedgerOf(scene) !== null,
  }));

  const applied: SplitApplyResult[] = [];
  const skipped: Array<{ sceneId: string; reason: string }> = [];

  for (const target of targets) {
    if (target.errors === 0 && !target.ledgered) continue;
    const result = applySplit(document as unknown as SplitApplyDocumentShape, String(target.scene.id));
    if (result) applied.push(result);
    else skipped.push({ sceneId: String(target.scene.id), reason: 'plan collapsed to one chunk or outline missing' });
  }

  if (applied.length > 0) {
    try {
      await documentStore.saveDocument(document as never);
    } catch (error) {
      console.error('[split-apply] saveDocument failed', error);
      // Roll the atomic contract the only way an in-memory document can:
      // report the failure; the next on-load pass recomputes the same split
      // from the SAME unchanged whitespace — a failed apply is a no-op win.
      return apiError('UPSTREAM_ERROR', 500, 'split apply failed at persistence time');
    }
  }

  return apiSuccess({
    courseId,
    scanned: targets.length,
    applied: applied.length,
    skipped: skipped.length,
    results: applied.map((result) => ({
      sceneId: result.sceneId,
      originalOrder: result.originalOrder,
      partScenes: result.parts.length,
      partOutlineIds: result.partOutlineIds,
    })),
  });
}

async function isUnauthorized(request: NextRequest): Promise<boolean> {
  const token = process.env.PERSISTENCE_DEV_TOKEN;
  const authorization = request.headers.get('authorization');
  if (!token) return true;
  return !authorization || authorization !== `Bearer ${token}`;
}
