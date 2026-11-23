import type { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { readContinueJob, readContinueJobInput } from '@/lib/server/continue-generation/store';
import { runContinueGenerationJob } from '@/lib/server/continue-generation/runner';

export const runtime = 'nodejs';
export const maxDuration = 30;

const log = createLogger('ContinueGeneration Execute');

/**
 * Internal dispatch endpoint used only by the detached worker. The job was
 * already claimed with a lock file; this route starts the scene loop after the
 * response settles so its own self-fetches to /api/generate/* cannot deadlock.
 */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as { jobId?: string };
    if (!body.jobId) return apiError('INVALID_REQUEST', 400, 'jobId is required');

    const job = await readContinueJob(body.jobId);
    if (!job) return apiError('INVALID_REQUEST', 404, 'Job not found');
    if (job.status === 'cancelled' || job.status === 'succeeded') {
      return apiSuccess({ accepted: false, status: job.status });
    }
    const input = await readContinueJobInput(body.jobId);
    if (!input) {
      return apiError('INVALID_REQUEST', 409, 'Job input unavailable; resume from the UI');
    }

    // Detached from this response: the runner calls this same server's generate
    // routes, which would deadlock inside an unfinished request.
    setTimeout(() => {
      void runContinueGenerationJob(body.jobId!, input, input.headers ?? {}).catch((error) =>
        log.error(`Job ${body.jobId} failed:`, error),
      );
    }, 100);

    return apiSuccess({ accepted: true, jobId: body.jobId });
  } catch (error) {
    log.error('Dispatch failed:', error);
    return apiError('INTERNAL_ERROR', 500, 'Dispatch failed');
  }
}
