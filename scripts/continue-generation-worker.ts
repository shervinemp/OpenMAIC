/**
 * Detached generation worker.
 *
 * Owns the long-running scene loop in its own OS process, so generation keeps
 * going across Next.js restarts and dev reloads. Jobs are claimed with an
 * exclusive lock and renewed with a heartbeat; a crashed worker's jobs are
 * reclaimed after the lease expires.
 */

import { hostname } from 'node:os';

import {
  claimContinueJob,
  findClaimableContinueJobs,
  isContinueJobCancelled,
  renewContinueJobLease,
  releaseContinueJob,
  type ContinueJobInput,
  readContinueJobInput,
} from '@/lib/server/continue-generation/store';
import {
  cancelContinueJob,
  runContinueGenerationJob,
} from '@/lib/server/continue-generation/runner';

const WORKER_ID = `${hostname()}-${process.pid}`;
const SCAN_MS = 2_000;
const HEARTBEAT_MS = 20_000;

const active = new Set<string>();

async function runOne(jobId: string, input: ContinueJobInput): Promise<void> {
  active.add(jobId);
  const heartbeat = setInterval(() => {
    void renewContinueJobLease(jobId, WORKER_ID);
    void isContinueJobCancelled(jobId).then((cancelled) => {
      if (cancelled) cancelContinueJob(jobId);
    });
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    await runContinueGenerationJob(jobId, input, input.headers ?? {});
  } finally {
    clearInterval(heartbeat);
    active.delete(jobId);
    await releaseContinueJob(jobId, WORKER_ID);
  }
}

async function scan(): Promise<void> {
  try {
    const claimable = await findClaimableContinueJobs();
    for (const job of claimable) {
      if (active.has(job.id)) continue;
      const claimed = await claimContinueJob(job.id, WORKER_ID);
      if (!claimed) continue;
      const input = await readContinueJobInput(job.id);
      if (!input) {
        await releaseContinueJob(job.id, WORKER_ID);
        continue;
      }
      void runOne(job.id, input).catch((error) => {
        console.error(`[continue-worker] job ${job.id} crashed:`, error);
      });
    }
  } catch (error) {
    console.error('[continue-worker] scan failed:', error);
  }
}

console.log(`[continue-worker] ${WORKER_ID} ready`);
void scan();
const timer = setInterval(() => void scan(), SCAN_MS);
timer.unref?.();

process.on('SIGTERM', () => {
  console.log('[continue-worker] stopping');
  process.exit(0);
});
