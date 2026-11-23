import type { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  cancelContinueJob,
} from '@/lib/server/continue-generation/runner';
import { readContinueJob, updateContinueJob } from '@/lib/server/continue-generation/store';

export const runtime = 'nodejs';

interface Params {
  params: Promise<{ jobId: string }>;
}

export async function GET(_req: NextRequest, { params }: Params): Promise<Response> {
  const { jobId } = await params;
  const job = await readContinueJob(jobId);
  if (!job) return apiError('INVALID_REQUEST', 404, 'Generation job not found');
  return apiSuccess({ job });
}

export async function DELETE(_req: NextRequest, { params }: Params): Promise<Response> {
  const { jobId } = await params;
  const job = await readContinueJob(jobId);
  if (!job) return apiError('INVALID_REQUEST', 404, 'Generation job not found');
  const aborted = cancelContinueJob(jobId);
  await updateContinueJob(jobId, { status: 'cancelled', message: 'Cancelled' });
  return apiSuccess({ cancelled: true, aborted });
}
