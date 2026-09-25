import { NextRequest } from 'next/server';
import { createCourseDocumentStore } from '@/lib/persistence/course-document-store';
import { computeSplitPlan, planSummary, type SplitPlan } from '@/lib/maintenance/split-plan';
import { apiError, apiSuccess } from '@/lib/server/api-response';

/**
 * Token-free, write-free split planning for layout-debt scenes. Post a
 * courseId and (optionally) scene ids; every flagged slide scene comes back
 * with its pagesplit plan — chunk titles, verbatim element/action ids —
 * NOTHING is written. Applying a plan is a separate, explicit step: the
 * atomic saveDocument surgery (order renumbering, outline entries, lesson
 * group jobs) is gated on the review of the plan itself.
 */
export async function POST(req: NextRequest) {
  const token = process.env.PERSISTENCE_DEV_TOKEN;
  const authorization = req.headers.get('authorization');
  if (!token || !authorization || authorization !== `Bearer ${token}`) {
    return apiError('UNAUTHENTICATED', 401, 'maintenance route requires the dev persistence token');
  }
  const fileDir = process.env.PERSISTENCE_DIR;
  if (!fileDir) {
    return apiError(
      'INVALID_REQUEST',
      503,
      'this route requires the file-backed persistence backend (PERSISTENCE_DIR)',
    );
  }
  let body: { courseId?: string; sceneIds?: string[] };
  try {
    body = (await req.json()) as { courseId?: string; sceneIds?: string[] };
  } catch {
    return apiError('INVALID_REQUEST', 400, 'body must be JSON');
  }
  const courseId = body.courseId?.trim();
  if (!courseId) return apiError('INVALID_REQUEST', 400, 'courseId is required');

  const documentStore = createCourseDocumentStore(fileDir);

  let document;
  try {
    document = await documentStore.loadDocument(courseId);
  } catch (error) {
    console.error('[split-plan] load failed', error);
    return apiError('UPSTREAM_ERROR', 500, 'course load failed');
  }
  if (!document) return apiError('INVALID_REQUEST', 404, 'course document not found');

  const requested = body.sceneIds?.length ? body.sceneIds : null;
  const targets = document.scenes.filter(
    (scene: { type?: string; id?: string }) =>
      scene.type === 'slide' && (!requested || requested!.includes(scene.id!)),
  );

  const plans: Array<SplitPlan & { summary: string }> = [];
  for (const scene of targets) {
    const plan = computeSplitPlan(scene as never);
    if (plan && plan.chunks.length > 1) plans.push({ ...plan, summary: planSummary(plan) });
  }
  plans.sort((a, b) => a.order - b.order);

  return apiSuccess({
    courseId,
    slideScenes: targets.length,
    splittable: plans.length,
    totalNewChunks: plans.reduce((sum, plan) => sum + plan.chunks.length, 0),
    plans,
  });
}
