import { NextRequest } from 'next/server';
import { JsonFileDocumentStore } from '@openmaic/storage/server/file-document-store';
import { GitSyncDocumentStore } from '@/lib/persistence/git-sync-document-store';
import { getCourseGitScheduler } from '@/lib/persistence/git-course-sync';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import {
  applyRelayoutMoves,
  computeRelayoutPlan,
  residualFindings,
  sanitizeSceneCanvas,
  type RelayoutPlan,
} from '@/lib/maintenance/layout-relayout';
import { callLLM } from '@/lib/ai/llm';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { apiError, apiSuccess } from '@/lib/server/api-response';

const MERGE_CALL_LIMIT = 40;

interface RequestBody {
  courseId: string;
  dryRun?: boolean;
  sceneIds?: string[];
  actionSourceStamps?: boolean;
}

const MERGE_SYSTEM_PROMPT = [
  'You receive the visible content rows of an over-stacked course slide (each row is a small HTML block).',
  'The rows no longer fit the slide after deterministic re-packing. Decide which rows are REDUNDANT and may be deleted to make the slide readable.',
  'Be conservative: delete a row ONLY when its material is clearly repeated or obviously dominated by a better row.',
  'Return STRICT JSON only: {"deleteIds":["elementId", ...]} — no prose, no other keys.',
].join('\n');

function mergeBudgetCrossed(checkpoint: { used: number }): boolean {
  return checkpoint.used >= MERGE_CALL_LIMIT;
}

export async function POST(req: NextRequest) {
  const unauthorized = await isUnauthorized(req);
  if (unauthorized) {
    return apiError('UNAUTHENTICATED', 401, 'maintenance route requires the dev persistence token');
  }
  const fileDir = process.env.PERSISTENCE_DIR;
  if (!fileDir) {
    return apiError('INVALID_REQUEST', 503, 'this route requires the file-backed persistence backend (PERSISTENCE_DIR)');
  }
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
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
    console.error('[layout-relayout] load failed', error);
    return apiError('UPSTREAM_ERROR', 500, 'course load failed');
  }
  if (!document) return apiError('INVALID_REQUEST', 404, 'course document not found');

  const targets = document.scenes.filter(
    (scene) => scene.type === 'slide' && (!body.sceneIds || body.sceneIds.includes(scene.id)),
  );

  const reports: Array<RelayoutPlan & { applied: boolean; residualErrors: number; mergedDeleted: string[] }> = [];
  const mergeCheckpoint = { used: 0 };

  for (const scene of targets) {
    const plan = computeRelayoutPlan(scene);
    if (!plan) continue;
    let applied = false;
    const mergedDeleted: string[] = [];

    if (!body.dryRun) {
      applyRelayoutMoves(scene, plan);
      sanitizeSceneCanvas(scene);

      if (plan.overflowRows.length > 0 && !mergeBudgetCrossed(mergeCheckpoint)) {
        const { model, thinkingConfig } = await resolveModelFromRequest(req, body as never, 'scene-verify');
        const slideCanvas = (scene.content as { canvas?: { elements?: Array<{ id: string; content?: string }> } } | undefined)?.canvas;
        const rows = slideCanvas?.elements ?? [];
        const rowSummaries = plan.overflowRows.map((id) => {
          const row = rows.find((entry) => entry.id === id);
          const text = String(row?.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400);
          return `${id}: ${text}`;
        });
        mergeCheckpoint.used += 1;
        try {
          const result = await callLLM(
            {
              model,
              system: MERGE_SYSTEM_PROMPT,
              prompt: `Rows (top order, slide budget exceeded):\n${rowSummaries.join('\n')}`,
              maxOutputTokens: 800,
              maxRetries: 0,
            } as never,
            'scene-verify',
            undefined,
            thinkingConfig ?? undefined,
          );
          const text = result.text ?? '';
          const parsed = JSON.parse(text.slice(Math.max(0, text.indexOf('{')), Math.max(0, text.lastIndexOf('}')) + 1)) as { deleteIds?: unknown };
          if (Array.isArray(parsed.deleteIds)) {
            const canvas = (scene.content as { canvas?: { elements?: Array<{ id: string }> } } | undefined)?.canvas;
            if (canvas && Array.isArray(canvas.elements)) {
              const deleteIds = new Set(
                parsed.deleteIds.filter((id): id is string => typeof id === 'string' && plan.overflowRows.includes(id)),
              );
              if (deleteIds.size > 0) {
                canvas.elements = canvas.elements.filter((element) => !deleteIds.has(element.id));
                mergedDeleted.push(...deleteIds);
              }
            }
          }
        } catch (error) {
          console.warn(`[layout-relayout] merge pass failed for scene ${scene.id}`, error);
        }
        sanitizeSceneCanvas(scene);
        if (mergedDeleted.length > 0) {
          const secondPass = computeRelayoutPlan(scene);
          if (secondPass && secondPass.moved.length > 0) {
            applyRelayoutMoves(scene, secondPass);
            sanitizeSceneCanvas(scene);
          }
        }
      }

      const residual = residualFindings(scene);
      try {
        await documentStore.putScene(courseId, scene as never);
        applied = true;
      } catch (error) {
        console.error('[layout-relayout] putScene failed', scene.id, error);
        continue;
      }
      reports.push({ ...plan, applied, residualErrors: residual.filter((f) => f.severity === 'error').length, mergedDeleted });
    } else {
      reports.push({ ...plan, applied, residualErrors: 0, mergedDeleted });
    }
  }

  return apiSuccess({
    courseId,
    dryRun: body.dryRun === true,
    scenesScanned: targets.length,
    scenesPlanned: reports.length,
    reports,
  });
}

async function isUnauthorized(request: NextRequest): Promise<boolean> {
  const token = process.env.PERSISTENCE_DEV_TOKEN;
  const authorization = request.headers.get('authorization');
  if (!token) return true;
  return !authorization || authorization !== `Bearer ${token}`;
}
