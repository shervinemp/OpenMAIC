import { NextRequest } from 'next/server';
import { JsonFileDocumentStore } from '@openmaic/storage/server/file-document-store';
import { GitSyncDocumentStore } from '@/lib/persistence/git-sync-document-store';
import { getCourseGitScheduler } from '@/lib/persistence/git-course-sync';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import {
  applyRelayoutMoves,
  computeRelayoutPlan,
  layoutLedgerOf,
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
  /**
   * Explicitly opt in to the LLM delete-only merge pass for overflow rows.
   * Default OFF for the MANUAL path (any explicit call stays token-free
   * unless the caller asks); the ON-LOAD pipeline passes it true — bounded
   * LLM (40 calls) is acceptable where it materially cures unsplittable
   * embraces of content redundancy. Red-card content is never rewritten
   * silently — the pass deletes only clearly redundant rows.
   */
  allowMerge?: boolean;
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

  const requestedIds = body.sceneIds?.length ? body.sceneIds : null;
  const targets = document.scenes.filter(
    (scene) => scene.type === 'slide' && (!requestedIds || requestedIds.includes(scene.id)),
  );

  const reports: Array<RelayoutPlan & { applied: boolean; residualErrors: number; mergedDeleted: string[] }> = [];
  const mergeCheckpoint = { used: 0 };
  const allowMerge = body.allowMerge === true;

  for (const scene of targets) {
    const plan = computeRelayoutPlan(scene);
    if (!plan && !layoutLedgerOf(scene)) {
      // Clean scene with no debt marker: write off implicitly (nothing to do).
      continue;
    }
    let applied = false;
    const mergedDeleted: string[] = [];

    if (!body.dryRun) {
      if (plan) {
        applyRelayoutMoves(scene, plan);
        sanitizeSceneCanvas(scene);
      }

      if (
        allowMerge &&
        plan &&
        plan.overflowRows.length > 0 &&
        !mergeBudgetCrossed(mergeCheckpoint)
      ) {
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
      const errorCount = residual.filter((f) => f.severity === 'error').length;
      // UNIFIED STATE: the layout phase lives in the job envelope (a fifth
      // phase beside content/actions/tts/media) — the single red/green source
      // for the generation panel and the lesson-list serving rule. Attempts
      // ratchet only on STATUS TRANSITIONS: a status-only re-check per
      // session updates the timestamp, not the history.
      const outlineId = (scene as { outlineId?: string }).outlineId;
      if (outlineId) {
        const outlineDoc = document as unknown as {
          outline?: { lessonGroups?: Array<{ jobs?: Array<{ outlineId: string; phases?: Record<string, { status?: string; attempts?: number; updatedAt?: number }> }> }> };
        };
        const group = outlineDoc.outline?.lessonGroups?.find((jobGroup) =>
          (jobGroup.jobs ?? []).some((job) => job.outlineId === outlineId),
        );
        if (group) {
          const job = group.jobs?.find((entry) => entry.outlineId === outlineId);
          if (job) {
            const now = Date.now();
            const previous = job.phases?.layout as { status?: 'pending' | 'running' | 'done' | 'failed'; attempts?: number } | undefined;
            const nextStatus = errorCount > 0 ? 'failed' : 'done';
            const transitioned = previous?.status !== undefined && previous.status !== nextStatus;
            job.phases = {
              ...(job.phases ?? {}),
              layout: {
                status: nextStatus,
                attempts: (previous?.attempts ?? 0) + (transitioned ? 1 : 0),
                updatedAt: now,
              },
            };
          }
        }
      }
      const beforeErrors = layoutLedgerOf(scene)?.errors ?? 0;
      const needsWrite = plan !== null || errorCount !== beforeErrors;
      if (needsWrite) {
        try {
          await documentStore.putScene(courseId, scene as never);
          applied = true;
        } catch (error) {
          console.error('[layout-relayout] putScene failed', scene.id, error);
          continue;
        }
      }
      reports.push({
        ...(plan ?? {
          sceneId: scene.id,
          sceneTitle: scene.title ?? '',
          moved: [],
          keptPinned: [],
          overflowRows: [],
          fitsWithoutMerge: true,
          findingsBefore: [],
          findingsAfter: [],
        }),
        applied,
        residualErrors: errorCount,
        mergedDeleted,
      });
    } else {
      const before = residualFindings(scene);
      const beforeErrors = before.filter((f) => f.severity === 'error').length;
      reports.push({
        ...(plan ?? {
          sceneId: scene.id,
          sceneTitle: scene.title ?? '',
          moved: [],
          keptPinned: [],
          overflowRows: [],
          fitsWithoutMerge: true,
          findingsBefore: [],
          findingsAfter: [],
        }),
        applied,
        residualErrors: beforeErrors,
        mergedDeleted,
      });
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
