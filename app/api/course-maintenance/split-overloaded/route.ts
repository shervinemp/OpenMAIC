import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { isMaintenanceUnauthorized } from '@/lib/server/maintenance-auth';
import { planSceneSplit, reflowSceneRows } from '@/lib/maintenance/split-overloaded-scene';
import { explodeWallRows } from '@/lib/maintenance/layout-relayout';
import { validateSlidePlacement } from '@openmaic/dsl';

export const runtime = 'nodejs';

/** True when a slide has error-severity text-on-text occlusion. */
function overloaded(scene: Record<string, unknown>): boolean {
  if (scene.type !== 'slide') return false;
  const canvas = (scene.content as { canvas?: { viewportSize?: number; viewportRatio?: number; elements?: unknown[] } } | undefined)?.canvas;
  if (!canvas || !Array.isArray(canvas.elements)) return false;
  let findings;
  try {
    findings = validateSlidePlacement({
      viewportSize: canvas.viewportSize,
      viewportRatio: canvas.viewportRatio,
      elements: canvas.elements,
    } as never);
  } catch {
    return false;
  }
  const types = new Map(
    (canvas.elements as Array<{ id?: string; type?: string }>).map((e) => [e.id, e.type]),
  );
  return findings.some((finding) => {
    if (finding.severity !== 'error') return false;
    const a = types.get((finding as { elementId?: string }).elementId);
    const b = types.get((finding as { otherElementId?: string }).otherElementId);
    return a === 'text' && b === 'text';
  });
}

export async function POST(request: Request): Promise<Response> {
  if (isMaintenanceUnauthorized(request)) return apiError('UNAUTHENTICATED', 401, 'Unauthorized');
  const body = (await request.json().catch(() => ({}))) as {
    courseId?: string;
    sceneIds?: string[];
    dryRun?: boolean;
  };
  const courseId = body.courseId?.trim() ?? '';
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

    const scenes = document.scenes as unknown as Array<Record<string, unknown>>;
    const wanted = Array.isArray(body.sceneIds) ? new Set(body.sceneIds) : null;
    const targets = scenes.filter((scene) => {
      if (wanted) return wanted.has(String(scene.id));
      return overloaded(scene);
    });

    const split: string[] = [];
    const reflowed: string[] = [];
    const skipped: string[] = [];
    const outline = document.outline as { outlines?: Array<Record<string, unknown>> } & Record<string, unknown>;
    const outlines = [...(outline.outlines ?? [])];
    const nextScenes = [...scenes];
    for (const target of targets) {
      const index = nextScenes.findIndex((scene) => scene.id === target.id);
      if (index < 0) continue;
      // Repacking is the cheap, lossless fix: most overlaps come from stacked
      // tops, not from too much content. Only split when repacking cannot fit.
      const unwrapped = JSON.parse(JSON.stringify(target)) as Record<string, unknown>;
      explodeWallRows(unwrapped);
      const packed = reflowSceneRows(unwrapped);
      if (packed && !overloaded(packed)) {
        nextScenes[index] = packed;
        reflowed.push(String(target.id));
        continue;
      }
      const plan = planSceneSplit(
        { ...document, scenes: nextScenes.map((s, i) => (i === index ? unwrapped : s)) } as never,
        String(target.id),
      );
      if (!plan) {
        skipped.push(String(target.id));
        continue;
      }
      nextScenes[index] = plan.scene;
      nextScenes.push(plan.continuation);
      outlines.push(plan.continuationOutline);
      split.push(String(target.id));
    }

    if ((split.length > 0 || reflowed.length > 0) && !body.dryRun) {
      await store.saveDocument({
        ...document,
        outline: { ...outline, outlines },
        scenes: nextScenes as never,
        stage: { ...document.stage, updatedAt: Date.now() },
      } as never);
    }
    return apiSuccess({
      courseId,
      dryRun: body.dryRun === true,
      candidates: targets.length,
      reflowed: reflowed.length,
      split: split.length,
      skipped: skipped.length,
    });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Overloaded slide split failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}
