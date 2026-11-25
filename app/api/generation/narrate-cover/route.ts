import { apiError, apiSuccess } from '@/lib/server/api-response';
import { synthesizeSceneNarration } from '@/lib/server/agent-runtime/scene-tts';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';

export const runtime = 'nodejs';

/**
 * Narrate the generated cover scene of a course. The cover is inserted by the
 * creation/backfill helper outside the normal scene loop, so it needs the same
 * server TTS path that the continuation runner uses for every other scene.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { stageId?: unknown };
  const stageId = typeof body.stageId === 'string' ? body.stageId : '';
  if (!/^[A-Za-z0-9_-]+$/.test(stageId)) {
    return apiError('INVALID_REQUEST', 400, 'A valid stageId is required');
  }
  const dir = process.env.PERSISTENCE_DIR;
  if (!dir) return apiError('INVALID_REQUEST', 400, 'Only the file-backed store is supported');

  try {
    const { JsonFileDocumentStore } = await import('@openmaic/storage/server/file-document-store');
    const store = new JsonFileDocumentStore({
      dir,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    const document = await store.loadDocument(stageId);
    if (!document) return apiError('INVALID_REQUEST', 404, 'Course not found');
    const index = document.scenes.findIndex((scene) =>
      String((scene as { outlineId?: unknown }).outlineId ?? '').startsWith('cover-outline-'),
    );
    if (index < 0) return apiError('INVALID_REQUEST', 404, 'Cover scene not found');

    const scene = document.scenes[index];
    const summary = await synthesizeSceneNarration({ scene, force: false });
    if (!summary.changed) return apiSuccess({ narrated: false, summary });

    const scenes = [...document.scenes];
    scenes[index] = scene;
    await store.saveDocument({
      ...document,
      scenes,
      stage: { ...document.stage, updatedAt: Date.now() },
    });
    return apiSuccess({ narrated: true, summary });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Cover narration failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}
