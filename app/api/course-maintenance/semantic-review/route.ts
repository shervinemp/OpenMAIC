import { NextRequest } from 'next/server';
import { createCourseDocumentStore } from '@/lib/persistence/course-document-store';
import { singleFlight } from '@/lib/server/single-flight';
import { callLLM } from '@/lib/ai/llm';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { apiError, apiSuccess, type ApiErrorCode } from '@/lib/server/api-response';
import {
  budgetCrossed,
  isReviewCandidate,
  judgeScene,
} from '@/lib/maintenance/semantic-review';

/**
 * Semantic review pass — READ-ONLY. One LLM call per candidate slide; the
 * result is a report the owner reviews (never auto-applied, never rewritten
 * content). Doctrine: see lib/maintenance/semantic-review.ts. The budget cap
 * bounds the whole pass so a stray call can never balloon the token spend.
 */
const REVIEW_CALL_LIMIT = 80;

interface RequestBody {
  courseId: string;
  /** Cap the pass at N judged scenes. */
  maxScenes?: number;
  /** Skip the first K candidates (resume full-coverage in budgeted steps). */
  offset?: number;
  /** Target specific scenes explicitly (review-this-one flows). */
  sceneIds?: string[];
}

type ReviewOutcome =
  | {
      ok: true;
      payload: {
        courseId: string;
        budgetLimit: number;
        budgetUsed: number;
        candidates: number;
        judged: number;
        unmatchedCalls: number;
        mismatchScenes: number;
        figureGaps: number;
        duplicates: number;
        findings: Array<{
          sceneId: string;
          title: string;
          order?: number;
          spotlightMismatches: Array<Record<string, unknown>>;
          conceptBeforeSubject: Array<Record<string, unknown>>;
          duplicateLessonNeighbor?: string;
          figureGap: Record<string, unknown>;
        }>;
      };
    }
  | { ok: false; code: ApiErrorCode; status: number; message: string };

async function isUnauthorized(request: NextRequest): Promise<boolean> {
  const token = process.env.PERSISTENCE_DEV_TOKEN;
  const authorization = request.headers.get('authorization');
  if (!token) return true;
  return !authorization || authorization !== `Bearer ${token}`;
}

export async function POST(req: NextRequest) {
  if (await isUnauthorized(req)) {
    return apiError('UNAUTHENTICATED', 401, 'review route requires the dev persistence token');
  }
  const fileDir = process.env.PERSISTENCE_DIR;
  if (!fileDir) {
    return apiError(
      'INVALID_REQUEST',
      503,
      'this route requires the file-backed persistence backend (PERSISTENCE_DIR)',
    );
  }
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'body must be JSON');
  }
  const courseId = body.courseId?.trim();
  if (!courseId) return apiError('INVALID_REQUEST', 400, 'courseId is required');

  const jobKey = `semantic-review:${courseId}:${body.maxScenes ?? 'full'}.${body.offset ?? 0}`;
  const outcome = await singleFlight(jobKey, async () => runReview(req, body, courseId, fileDir));
  return outcome.ok
    ? apiSuccess(outcome.payload)
    : apiError(outcome.code, outcome.status, outcome.message);
}

async function runReview(
  req: NextRequest,
  body: RequestBody,
  courseId: string,
  fileDir: string,
): Promise<ReviewOutcome> {
  const documentStore = createCourseDocumentStore(fileDir);
  let document;
  try {
    document = await documentStore.loadDocument(courseId);
  } catch (error) {
    console.error('[semantic-review] load failed', error);
    return { ok: false, code: 'UPSTREAM_ERROR', status: 500, message: 'course load failed' };
  }
  if (!document) {
    return { ok: false, code: 'INVALID_REQUEST', status: 404, message: 'course document not found' };
  }

  const budget = { used: 0, limit: REVIEW_CALL_LIMIT };
  const maxScenes = typeof body.maxScenes === 'number' && body.maxScenes > 0 ? body.maxScenes : undefined;
  const requestedIds = body.sceneIds?.length ? new Set(body.sceneIds) : null;
  const candidates = (document.scenes as unknown as Array<Record<string, unknown>>)
    .filter((scene) => scene.type === 'slide' && isReviewCandidate(scene as never));
  const base = requestedIds
    ? candidates.filter((scene) => requestedIds.has(String(scene.id)))
    : candidates.slice(typeof body.offset === 'number' && body.offset > 0 ? body.offset : 0);
  const targets = (maxScenes && !requestedIds ? base.slice(0, maxScenes) : base);

  const findings: Array<{
    sceneId: string;
    title: string;
    order?: number;
    spotlightMismatches: Array<Record<string, unknown>>;
    conceptBeforeSubject: Array<Record<string, unknown>>;
    duplicateLessonNeighbor?: string;
    figureGap: Record<string, unknown>;
  }> = [];
  const failures: Array<{ sceneId: string; error: string }> = [];
  let judged = 0;
  let modelFailures = 0;

  for (const scene of targets) {
    if (budgetCrossed(budget)) break;
    budget.used += 1;
    const { model } = await resolveModelFromRequest(req, body as never, 'scene-verify');
    // Read-only classification: thinking budget burnout was casting the entire
    // judge pass into empty `finishReason: length` responses — the verdict is
    // a JSON silhouette over maybe 300 tokens; thinking is disabled explicitly
    // so the review pass is both cheap and deterministic-shaped.
    const outcome = await judgeScene({
      scene: scene as never,
      callLLMImpl: callLLM,
      model,
      thinkingConfig: { mode: 'disabled', enabled: false },
    });
    if (!outcome.verdict) {
      modelFailures += 1;
      failures.push({ sceneId: String(scene.id), error: outcome.error ?? 'unknown' });
      continue;
    }
    const verdict = outcome.verdict;
    const hasFindings =
      verdict.spotlightMismatches.length > 0 ||
      verdict.conceptBeforeSubject.length > 0 ||
      Boolean(verdict.duplicateLessonNeighbor) ||
      Object.keys(verdict.figureGap).length > 0;
    if (!hasFindings) continue;
    judged += 1;
    findings.push({
      sceneId: String(scene.id),
      title: String(scene.title ?? ''),
      order: typeof scene.order === 'number' ? scene.order : undefined,
      spotlightMismatches: verdict.spotlightMismatches as unknown as Array<Record<string, unknown>>,
      conceptBeforeSubject: verdict.conceptBeforeSubject as unknown as Array<Record<string, unknown>>,
      ...(verdict.duplicateLessonNeighbor ? { duplicateLessonNeighbor: verdict.duplicateLessonNeighbor } : {}),
      figureGap: verdict.figureGap as Record<string, unknown>,
    });
  }

  return {
    ok: true,
    payload: {
      courseId,
      budgetLimit: REVIEW_CALL_LIMIT,
      budgetUsed: budget.used,
      candidates: targets.length,
      judged,
      unmatchedCalls: modelFailures,
      ...(failures.length > 0 ? { failures: failures.slice(0, 12) } : {}),
      mismatchScenes: findings.filter((f) => f.spotlightMismatches.length > 0).length,
      figureGaps: findings.filter((f) => Object.keys(f.figureGap).length > 0).length,
      duplicates: findings.filter((f) => f.duplicateLessonNeighbor).length,
      findings,
    },
  };
}
