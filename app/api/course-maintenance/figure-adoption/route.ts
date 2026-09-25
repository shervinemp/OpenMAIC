import { NextRequest } from 'next/server';
import { createCourseDocumentStore } from '@/lib/persistence/course-document-store';
import { singleFlight } from '@/lib/server/single-flight';
import { apiError, apiSuccess, type ApiErrorCode } from '@/lib/server/api-response';
import { validateSlidePlacement, sanitizeSlidePlacement } from '@openmaic/dsl';

/**
 * Figure adoption — the human-confirmed apply path for figure-gap proposals.
 * Appends ONLY validated proposed shapes (fig_-prefixed boxes/lines with
 * optional short labels) to the owning scene canvas, then re-validates the
 * WHOLE canvas with the placement validator before committing: a diagram that
 * would introduce geometry debt is refused, not written. dryRun default.
 * Idempotent: an adoption whose shapes already exist (id repeated on the
 * canvas) is a structured skip.
 */

interface AdoptionRequest {
  sceneId: string;
  shapes: Array<{
    id: string;
    kind: 'box' | 'line';
    left: number;
    top: number;
    width: number;
    height: number;
    label?: string;
  }>;
}

interface RequestBody {
  courseId: string;
  adoptions: AdoptionRequest[];
  dryRun?: boolean;
}

type AdoptionRouteOutcome =
  | {
      ok: true;
      payload: {
        courseId: string;
        requested: number;
        applied: number;
        dryRun: boolean;
        skipped: Array<{ sceneId: string; reason: string }>;
      };
    }
  | { ok: false; code: ApiErrorCode; status: number; message: string };

const BODY_TOP = 150;
const BODY_BOTTOM = 540;

async function isUnauthorized(request: NextRequest): Promise<boolean> {
  const token = process.env.PERSISTENCE_DEV_TOKEN;
  const authorization = request.headers.get('authorization');
  if (!token) return true;
  return !authorization || authorization !== `Bearer ${token}`;
}

export async function POST(req: NextRequest) {
  if (await isUnauthorized(req)) {
    return apiError(
      'UNAUTHENTICATED',
      401,
      'figure-adoption route requires the dev persistence token',
    );
  }
  const fileDir = process.env.PERSISTENCE_DIR;
  if (!fileDir) {
    return apiError(
      'INVALID_REQUEST',
      503,
      'this route requires the file-backed persistence backend',
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
  const dryRun = body.dryRun !== false;
  const jobKey = `figure-adoption:${courseId}:${body.adoptions.length}:${dryRun ? 'dry' : 'apply'}`;
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
): Promise<AdoptionRouteOutcome> {
  const documentStore = createCourseDocumentStore(fileDir);
  let document;
  try {
    document = await documentStore.loadDocument(courseId);
  } catch (error) {
    console.error('[figure-adoption] load failed', error);
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

  const skipped: Array<{ sceneId: string; reason: string }> = [];
  let applied = 0;

  for (const adoption of body.adoptions) {
    const scene = byId.get(String(adoption.sceneId));
    if (!scene) {
      skipped.push({ sceneId: String(adoption.sceneId), reason: 'scene not found' });
      continue;
    }
    const canvas = (
      scene as {
        content?: {
          canvas?: {
            viewportSize?: number;
            viewportRatio?: number;
            elements?: Array<Record<string, unknown>>;
          };
        };
      }
    ).content?.canvas;
    if (!canvas || !Array.isArray(canvas.elements)) {
      skipped.push({ sceneId: String(adoption.sceneId), reason: 'no canvas (non-slide?)' });
      continue;
    }
    const existingIds = new Set(canvas.elements.map((el) => el.id as string).filter(Boolean));
    // Idempotence: shapes whose ids are already on the canvas = adopt already
    // ran; skip instead of doubling the diagram.
    if (adoption.shapes.every((shape) => existingIds.has(shape.id))) {
      skipped.push({
        sceneId: String(adoption.sceneId),
        reason: 'all shapes already on canvas (already adopted)',
      });
      continue;
    }
    const fabricated = adoption.shapes.filter((shape) => {
      if (typeof shape?.id !== 'string' || !shape.id) return true;
      if (!shape.id.startsWith('fig_')) return true;
      if (existingIds.has(shape.id)) return true;
      if (shape.kind !== 'box' && shape.kind !== 'line') return true;
      return [shape.left, shape.top, shape.width, shape.height].some(
        (value) => !Number.isFinite(Number(value)),
      );
    });
    if (fabricated.length > 0) {
      skipped.push({
        sceneId: String(adoption.sceneId),
        reason: `malformed proposal shapes: ${fabricated.map((s) => s.id).join(', ')}`,
      });
      continue;
    }
    for (const shape of adoption.shapes) {
      const top = Number(shape.top);
      const left = Number(shape.left);
      if (top < BODY_TOP - 8 || top > BODY_BOTTOM || left < 32 || left > 968) {
        skipped.push({
          sceneId: String(adoption.sceneId),
          reason: 'shape coordinates outside the body band',
        });
        continue;
      }
    }
    const canvasTouched = canvas;
    if (dryRun) {
      applied += adoption.shapes.length;
      continue;
    }
    // Silent-proof the write: validate the proposed canvas WHOLE first, then
    // commit. A diagram that would introduce geometry debt is refused, not
    // healed later.
    const nextElements = [
      ...(canvasTouched.elements ?? []),
      ...adoption.shapes.map((shape): Record<string, unknown> => {
        if (shape.kind === 'line') {
          const lineWidth = Math.max(2, Number(shape.width));
          const lineHeight = Math.max(2, Number(shape.height));
          return {
            id: shape.id,
            type: 'line',
            left: shape.left,
            top: shape.top,
            width: lineWidth,
            height: lineHeight,
          };
        }
        const element: Record<string, unknown> = {
          id: shape.id,
          type: 'shape',
          left: shape.left,
          top: shape.top,
          width: Number(shape.width),
          height: Math.max(2, Number(shape.height)),
          path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
          viewBox: [1, 1],
          fixedRatio: false,
          fill: '#e8edf4',
          strokeWidth: 1,
          strokeColor: '#1f3864',
        };
        if (typeof shape.label === 'string' && shape.label) {
          element.text = shape.label;
          element.textType = 'text';
        }
        return element;
      }),
    ];
    const probe = {
      viewportSize: canvas.viewportSize ?? 1000,
      viewportRatio: canvas.viewportRatio ?? 0.5625,
      elements: nextElements as never,
    };
    const findings = validateSlidePlacement(probe as never);
    if (findings.some((f) => f.severity === 'error')) {
      const names = findings
        .filter((f) => f.severity === 'error')
        .map((f) => `${f.kind}:${f.elementId}`)
        .join(', ')
        .slice(0, 160);
      skipped.push({
        sceneId: String(adoption.sceneId),
        reason: `validator error after merge: ${names}`,
      });
      continue;
    }
    canvasTouched.elements = nextElements;
    const sanitizeResult = sanitizeSlidePlacement(canvasTouched as never);
    for (const change of sanitizeResult.changes) {
      console.warn(
        `[figure-adoption] sanitize adjusted ${change.elementId} for canvas ${String(adoption.sceneId)}`,
      );
    }
    try {
      await documentStore.putScene(courseId, scene as never);
      applied += adoption.shapes.length;
    } catch (error) {
      console.error('[figure-adoption] putScene failed', String(scene.id), error);
      skipped.push({ sceneId: String(adoption.sceneId), reason: 'putScene write failed' });
    }
  }

  return {
    ok: true,
    payload: { courseId, requested: body.adoptions.length, applied, dryRun, skipped },
  };
}
