import type { NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  createContinueJob,
  findActiveContinueJobByStage,
  type ContinueJobInput,
} from '@/lib/server/continue-generation/store';
import { ensureContinueWorker } from '@/lib/server/continue-generation/worker-starter';

export const runtime = 'nodejs';
export const maxDuration = 30;

const log = createLogger('ContinueGeneration API');

const SECRET_HEADERS = new Set([
  'x-api-key',
  'x-image-api-key',
  'x-video-api-key',
  'x-tts-api-key',
]);

/** Model/provider selection only — no credential is ever written to disk. */
function forwardedHeaders(req: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of req.headers.entries()) {
    if (name.startsWith('x-') && !SECRET_HEADERS.has(name)) headers[name] = value;
  }
  return headers;
}

async function start(req: NextRequest, ownerId: string): Promise<Response> {
  let stageId = 'unknown';
  try {
    const body = (await req.json()) as {
      stageId?: string;
      includeFailed?: boolean;
      languageDirective?: string;
      userProfile?: string;
      taskEngineMode?: boolean;
      enableTTS?: boolean;
      outlineIds?: string[];
    };
    stageId = body.stageId ?? 'unknown';
    if (!body.stageId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
    }

    // One active run per course. Every surface (Home, classroom retry, preview)
    // funnels through here, so a second engine can never start for the same doc.
    const active = await findActiveContinueJobByStage(stageId);
    if (active) {
      return apiError(
        'GENERATION_ALREADY_ACTIVE',
        409,
        'A generation job is already active for this course; stop it first',
        active.id,
      );
    }

    const outlineIds = Array.isArray(body.outlineIds)
      ? body.outlineIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 500)
      : undefined;

    const baseUrl = buildRequestOrigin(req);
    const jobId = nanoid(10);
    const input: ContinueJobInput = {
      stageId: body.stageId,
      ownerId,
      baseUrl,
      ...(typeof body.includeFailed === 'boolean' ? { includeFailed: body.includeFailed } : {}),
      ...(typeof body.languageDirective === 'string'
        ? { languageDirective: body.languageDirective }
        : {}),
      ...(typeof body.userProfile === 'string' ? { userProfile: body.userProfile } : {}),
      ...(typeof body.taskEngineMode === 'boolean' ? { taskEngineMode: body.taskEngineMode } : {}),
      ...(typeof body.enableTTS === 'boolean' ? { enableTTS: body.enableTTS } : {}),
      ...(outlineIds?.length ? { outlineIds } : {}),
    };
    const job = await createContinueJob(jobId, {
      ...input,
      headers: forwardedHeaders(req),
    });
    // A separate process owns the run, so Next.js reloads cannot interrupt it.
    await ensureContinueWorker(baseUrl);

    return apiSuccess(
      {
        jobId,
        status: job.status,
        pollUrl: `${baseUrl}/api/generation/continue/${jobId}`,
        pollIntervalMs: 3000,
      },
      202,
    );
  } catch (error) {
    log.error(`Failed to start continuation for ${stageId}:`, error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to start generation',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Unified status lookup for a course, used by every generation surface. */
export async function GET(req: NextRequest): Promise<Response> {
  const stageId = req.nextUrl.searchParams.get('stageId');
  if (!stageId) return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
  const job = await findActiveContinueJobByStage(stageId);
  return apiSuccess({ job });
}

export async function POST(req: NextRequest): Promise<Response> {
  // The localhost file backend has one owner; no owner cookies are involved.
  if (process.env.PERSISTENCE_DIR) {
    return start(req, 'local');
  }
  return withRequestOwner(req, (principal) => start(req, principal.ownerId));
}
