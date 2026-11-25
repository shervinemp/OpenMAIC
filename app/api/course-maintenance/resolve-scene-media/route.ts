import { apiError, apiSuccess } from '@/lib/server/api-response';
import { isMaintenanceUnauthorized } from '@/lib/server/maintenance-auth';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { resolveSceneMedia } from '@/lib/server/scene-media-generation';

export const runtime = 'nodejs';

/**
 * Resolve unresolved generated-media placeholders in an existing course
 * using the same server-side media path the generation runner uses. Bytes are
 * allocated under the local owner and the allocated ids are written back into
 * the affected scenes; all other scenes are untouched.
 */
export async function POST(request: Request): Promise<Response> {
  if (isMaintenanceUnauthorized(request)) return apiError('UNAUTHENTICATED', 401, 'Unauthorized');
  const body = (await request.json().catch(() => ({}))) as {
    courseId?: unknown;
    sceneIds?: unknown;
  };
  const courseId = typeof body.courseId === 'string' ? body.courseId : '';
  if (!/^[A-Za-z0-9_-]+$/.test(courseId)) {
    return apiError('INVALID_REQUEST', 400, 'A valid courseId is required');
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
    const document = await store.loadDocument(courseId);
    if (!document) return apiError('INVALID_REQUEST', 404, 'Course not found');
    const outlines = new Map(
      ((document.outline as { outlines?: Array<{ id: string; mediaGenerations?: unknown }> })
        .outlines ?? []).map((outline) => [outline.id, outline]),
    );
    const wanted = Array.isArray(body.sceneIds)
      ? new Set(body.sceneIds.filter((id): id is string => typeof id === 'string'))
      : null;
    const scenes = [...document.scenes];
    let resolved = 0;
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index];
      if (wanted && !wanted.has(scene.id)) continue;
      if (!/gen_img_\d|gen_vid_\d/.test(JSON.stringify(scene))) continue;
      const outlineId = (scene as unknown as { outlineId?: unknown }).outlineId;
      const outline = outlines.get(typeof outlineId === 'string' ? outlineId : '');
      if (!outline) continue;
      const result = await resolveSceneMedia({
        scene,
        outline: outline as never,
        stageId: courseId,
        ownerId: 'local',
      });
      if (result.generated.length > 0) {
        scenes[index] = result.scene as unknown as (typeof scenes)[number];
        resolved += result.generated.length;
      }
    }
    if (resolved > 0) {
      await store.saveDocument({
        ...document,
        scenes,
        stage: { ...document.stage, updatedAt: Date.now() },
      });
    }
    return apiSuccess({ courseId, resolved });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Scene media resolution failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}
