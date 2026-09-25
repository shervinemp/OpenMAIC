import { NextRequest } from 'next/server';
import { createCourseDocumentStore } from '@/lib/persistence/course-document-store';
import { singleFlight } from '@/lib/server/single-flight';
import { apiError, apiSuccess, type ApiErrorCode } from '@/lib/server/api-response';

/**
 * Semantic adoption pass — the human-confirmed fix path for the read-only
 * review. Each adoption is one judged finding applied as a retarget of ONE
 * spotlight action's elementId: narration, speech text, content, models, and
 * audio all stay; only the focus ring repoints. The route never invents the
 * target — betterElementId must be an element already on the canvas.
 *
 * Idempotent: an adoption whose anchor no longer holds (already applied,
 * element renamed, verdict stale) is reported SKIPPED, not failed.
 * dryRun defaults true: an apply must be explicit.
 */
interface Adoption {
  sceneId: string;
  /** The element the spotlight currently highlights (safety anchor). */
  highlightedElementId: string;
  betterElementId: string;
}

interface RequestBody {
  courseId: string;
  adoptions: Adoption[];
  dryRun?: boolean;
}

type AdoptionOutcome =
  | {
      ok: true;
      payload: {
        courseId: string;
        requested: number;
        applied: number;
        dryRun: boolean;
        skipped: Array<{ sceneId: string; highlightedElementId: string; reason: string }>;
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
    return apiError('UNAUTHENTICATED', 401, 'adoption route requires the dev persistence token');
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
  if (!courseId || !Array.isArray(body.adoptions)) {
    return apiError('INVALID_REQUEST', 400, 'courseId and adoptions[] are required');
  }
  for (const adoption of body.adoptions) {
    if (!adoption?.sceneId || !adoption?.highlightedElementId || !adoption?.betterElementId) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'each adoption requires sceneId, highlightedElementId and betterElementId',
      );
    }
  }

  const dryRun = body.dryRun !== false;
  const jobKey = `semantic-adoption:${courseId}:${body.adoptions.length}:${dryRun ? 'dry' : 'apply'}`;
  const outcome = await singleFlight(jobKey, () => runAdoption(body, courseId, fileDir, dryRun));
  return outcome.ok
    ? apiSuccess(outcome.payload)
    : apiError(outcome.code, outcome.status, outcome.message);
}

async function runAdoption(
  body: RequestBody,
  courseId: string,
  fileDir: string,
  dryRun: boolean,
): Promise<AdoptionOutcome> {
  const documentStore = createCourseDocumentStore(fileDir);
  let document;
  try {
    document = await documentStore.loadDocument(courseId);
  } catch (error) {
    console.error('[semantic-adoption] load failed', error);
    return { ok: false, code: 'UPSTREAM_ERROR', status: 500, message: 'course load failed' };
  }
  if (!document) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      status: 404,
      message: 'course document not found',
    };
  }
  const byId = new Map<string, Record<string, unknown>>();
  for (const scene of document.scenes as unknown as Array<Record<string, unknown>>) {
    byId.set(String(scene.id), scene);
  }

  const skipped: Array<{ sceneId: string; highlightedElementId: string; reason: string }> = [];
  let applied = 0;

  for (const adoption of body.adoptions) {
    const scene = byId.get(String(adoption.sceneId));
    const highlightId = String(adoption.highlightedElementId);
    const betterId = String(adoption.betterElementId);
    if (!scene) {
      skipped.push({ sceneId: String(adoption.sceneId), highlightedElementId: highlightId, reason: 'scene not found' });
      continue;
    }
    // The adopt target MUST exist on this canvas: a route that "invents" a
    // target manufactures the same dead-anchor class the write-time guard
    // forbids. Refuse loudly instead.
    const targetExists = (
      (scene as { content?: { canvas?: { elements?: Array<{ id?: string }> } } }).content?.canvas
        ?.elements ?? []
    ).some((el) => el.id === betterId);
    if (!targetExists) {
      skipped.push({
        sceneId: String(adoption.sceneId),
        highlightedElementId: highlightId,
        reason: `betterElementId "${betterId}" is not on this canvas`,
      });
      continue;
    }
    // Retarget exactly the spotlights anchored at the OLD element: the
    // highlight elementId is the safety anchor, so an adopted/stale finding
    // is a structured skip, never a best-guess rewrote of other spotlights.
    const actions = ((scene as { actions?: Array<Record<string, unknown>> }).actions ??
      []) as Array<Record<string, unknown>>;
    const live = actions.filter(
      (action) => action.type === 'spotlight' && action.elementId === highlightId,
    );
    if (live.length === 0) {
      skipped.push({
        sceneId: String(adoption.sceneId),
        highlightedElementId: highlightId,
        reason: 'no spotlight anchored at that element (already adopted, or verdict stale)',
      });
      continue;
    }
    if (dryRun) {
      applied += live.length;
      continue;
    }
    for (const action of live) {
      action.elementId = betterId;
    }
    applied += live.length;
    try {
      await documentStore.putScene(courseId, scene as never);
    } catch (error) {
      console.error('[semantic-adoption] putScene failed', String(scene.id), error);
      applied -= live.length;
      skipped.push({
        sceneId: String(scene.id),
        highlightedElementId: highlightId,
        reason: 'putScene write failed',
      });
    }
  }

  return {
    ok: true,
    payload: {
      courseId,
      requested: body.adoptions.length,
      applied,
      dryRun,
      skipped,
    },
  };
}
