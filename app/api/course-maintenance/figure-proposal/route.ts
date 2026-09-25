import { NextRequest } from 'next/server';
import { createCourseDocumentStore } from '@/lib/persistence/course-document-store';
import { singleFlight } from '@/lib/server/single-flight';
import { callLLM } from '@/lib/ai/llm';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { apiError, apiSuccess, type ApiErrorCode } from '@/lib/server/api-response';
import { budgetCrossed, proposeFigure, type FigureProposal } from '@/lib/maintenance/figure-proposal';

/**
 * Figure-gap proposal generation — READ-ONLY. For each confirmed figure-gap
 * scene one LLM call proposes a strict typed diagram (validatePolicyProposal
 * enforces ids, kinds, coordinates, budget). Nothing is applied here: the
 * proposals ride the response and the owner confirms them via the adoption
 * route (dry-run default there too). Never silent, per the doctrine.
 */
const PROPOSAL_CALL_LIMIT = 30;

interface RequestTarget {
  sceneId: string;
  figureGapReason?: string;
}

interface RequestBody {
  courseId: string;
  /** The figure-gap findings from the semantic-review report. */
  targets: RequestTarget[];
}

type ProposalRouteOutcome =
  | {
      ok: true;
      payload: {
        courseId: string;
        budgetLimit: number;
        budgetUsed: number;
        proposed: number;
        declined: number;
        findings: Array<{ sceneId: string; reason: string }>;
        proposals: FigureProposal[];
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
    return apiError('UNAUTHENTICATED', 401, 'proposal route requires the dev persistence token');
  }
  const fileDir = process.env.PERSISTENCE_DIR;
  if (!fileDir) {
    return apiError('INVALID_REQUEST', 503, 'this route requires the file-backed persistence backend');
  }
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'body must be JSON');
  }
  const courseId = body.courseId?.trim();
  if (!courseId || !Array.isArray(body.targets)) {
    return apiError('INVALID_REQUEST', 400, 'courseId and targets[] are required');
  }

  const jobKey = `figure-proposal:${courseId}:${body.targets.length}`;
  const outcome = await singleFlight(jobKey, async () => runProposal(req, body, courseId, fileDir));
  return outcome.ok
    ? apiSuccess(outcome.payload)
    : apiError(outcome.code, outcome.status, outcome.message);
}

async function runProposal(
  req: NextRequest,
  body: RequestBody,
  courseId: string,
  fileDir: string,
): Promise<ProposalRouteOutcome> {
  const documentStore = createCourseDocumentStore(fileDir);
  let document;
  try {
    document = await documentStore.loadDocument(courseId);
  } catch (error) {
    console.error('[figure-proposal] load failed', error);
    return { ok: false, code: 'UPSTREAM_ERROR', status: 500, message: 'course load failed' };
  }
  if (!document) {
    return { ok: false, code: 'INVALID_REQUEST', status: 404, message: 'course document not found' };
  }
  const byId = new Map<string, Record<string, unknown>>();
  for (const scene of document.scenes as unknown as Array<Record<string, unknown>>) {
    byId.set(String(scene.id), scene);
  }
  const budget = { used: 0, limit: PROPOSAL_CALL_LIMIT };
  const proposals: FigureProposal[] = [];
  const failed: Array<{ sceneId: string; reason: string }> = [];
  let declined = 0;

  for (const target of body.targets.slice(0, PROPOSAL_CALL_LIMIT)) {
    if (budgetCrossed(budget)) break;
    budget.used += 1;
    const scene = byId.get(String(target.sceneId));
    if (!scene) {
      failed.push({ sceneId: String(target.sceneId), reason: 'scene not found' });
      continue;
    }
    const { model } = await resolveModelFromRequest(req, body as never, 'scene-verify');
    const outcome = await proposeFigure({
      scene: scene as never,
      figureGapReason: target.figureGapReason,
      callLLMImpl: callLLM,
      model,
      thinkingConfig: { mode: 'disabled', enabled: false },
    });
    if (!outcome.proposal) {
      failed.push({ sceneId: String(target.sceneId), reason: outcome.error ?? 'unknown' });
      continue;
    }
    if (!outcome.proposal.shapes.length) {
      declined += 1;
      continue;
    }
    proposals.push(outcome.proposal);
  }

  return {
    ok: true,
    payload: {
      courseId,
      budgetLimit: PROPOSAL_CALL_LIMIT,
      budgetUsed: budget.used,
      proposed: proposals.length,
      declined,
      proposals,
      findings: failed.slice(0, 10),
    },
  };
}
