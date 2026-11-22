import { type NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { cancelClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import { isValidClassroomJobId } from '@/lib/server/classroom-job-store';

const log = createLogger('CancelClassroomJob API');

export const dynamic = 'force-dynamic';

/** Cancel a one-shot classroom generation job and stop its in-flight work. */
export async function POST(_req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  let resolvedJobId: string | undefined;
  try {
    const { jobId } = await context.params;
    resolvedJobId = jobId;
    if (!isValidClassroomJobId(jobId)) {
      return apiError('INVALID_REQUEST', 400, 'Invalid classroom generation job id');
    }

    const job = await cancelClassroomGenerationJob(jobId);
    if (!job) {
      return apiError('INVALID_REQUEST', 404, 'Classroom generation job not found');
    }

    return apiSuccess({
      jobId: job.id,
      status: job.status,
      cancelled: job.status === 'cancelled',
      message: job.message,
    });
  } catch (error) {
    log.error(`Classroom job cancel failed [jobId=${resolvedJobId ?? 'unknown'}]:`, error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to cancel classroom generation job',
      error instanceof Error ? error.message : String(error),
    );
  }
}
