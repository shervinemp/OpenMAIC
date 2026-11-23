import type { NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { createContinueJob, type ContinueJobInput } from '@/lib/server/continue-generation/store';
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
    };
    stageId = body.stageId ?? 'unknown';
    if (!body.stageId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
    }

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
    };
    const job = await createContinueJob(jobId, {
      ...input,
      headers: forwardedHeaders(req),
    });
    // A separate process owns the run, so Next.js reloads cannot interrupt it.
    await ensureContinueWorker();

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

export async function POST(req: NextRequest): Promise<Response> {
  // The localhost file backend has one owner; no owner cookies are involved.
  if (process.env.PERSISTENCE_DIR) {
    return start(req, 'local');
  }
  return withRequestOwner(req, (principal) => start(req, principal.ownerId));
}
