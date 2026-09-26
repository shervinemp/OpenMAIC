import { createLogger } from '@/lib/logger';
import type { GenerateClassroomInput } from '@/lib/server/classroom-generation';
import {
  deleteClassroomJobInput,
  listClassroomGenerationJobIds,
  markClassroomGenerationJobFailed,
  markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded,
  readClassroomGenerationJobRecord,
  readClassroomJobInput,
  updateClassroomGenerationJob,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';

const log = createLogger('ClassroomJob');
const runningJobs = new Map<string, Promise<void>>();

export function runClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  baseUrl: string,
): Promise<void> {
  const existing = runningJobs.get(jobId);
  if (existing) {
    return existing;
  }

  const jobPromise = (async () => {
    try {
      await markClassroomGenerationJobRunning(jobId);

      // Loaded when a job runs: the job poll route imports this module for
      // recovery, and a poll must not pull in the whole generation stack.
      const { generateClassroom } = await import('@/lib/server/classroom-generation');
      const result = await generateClassroom(input, {
        baseUrl,
        onProgress: async (progress) => {
          await updateClassroomGenerationJobProgress(jobId, progress);
        },
      });

      await markClassroomGenerationJobSucceeded(jobId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Classroom generation job ${jobId} failed:`, error);
      try {
        await markClassroomGenerationJobFailed(jobId, message);
      } catch (markFailedError) {
        log.error(`Failed to persist failed status for job ${jobId}:`, markFailedError);
      }
    } finally {
      runningJobs.delete(jobId);
    }
    // Settled either way: the job will not run again, so its input goes.
    await deleteClassroomJobInput(jobId);
  })();

  runningJobs.set(jobId, jobPromise);
  return jobPromise;
}

/**
 * How long a queued/running job must have been silent before a run with no
 * runner in this process counts as interrupted. Generation reports progress at
 * every step, and a job this process runs is never taken for interrupted (it
 * is in `runningJobs`), so this only has to outlast the gap between a job's
 * creation and its runner starting, and keep an instance from adopting a
 * job another instance sharing the directory is actively running.
 */
export const INTERRUPTED_JOB_GRACE_MS = 90_000;

/** Restarts allowed per job before an interrupted run fails for good. */
export const MAX_CLASSROOM_JOB_RESUMES = 2;

/**
 * Restart a generation job whose run was lost (the process stopped or
 * restarted while it was queued or running). Generation holds its work in
 * memory until the classroom is persisted, so an interrupted run has nothing
 * partial to continue from: the job runs again from its saved input. Without
 * this the job sat "running" until the stale timeout and then failed, and the
 * user had to submit it again.
 *
 * Returns whether a run was started. Jobs from before inputs were saved, and
 * jobs past their resume budget, are left to the stale timeout.
 */
export async function recoverInterruptedClassroomJob(
  jobId: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (runningJobs.has(jobId)) return false;
  const job = await readClassroomGenerationJobRecord(jobId);
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return false;
  if (now - new Date(job.updatedAt).getTime() < INTERRUPTED_JOB_GRACE_MS) return false;
  const saved = await readClassroomJobInput(jobId);
  if (!saved) return false;

  const resumeCount = job.resumeCount ?? 0;
  if (resumeCount >= MAX_CLASSROOM_JOB_RESUMES) {
    log.warn(`Classroom generation job ${jobId} was interrupted again; giving up.`);
    await markClassroomGenerationJobFailed(
      jobId,
      `Generation was interrupted ${resumeCount + 1} times and was not restarted again`,
    );
    await deleteClassroomJobInput(jobId);
    return false;
  }

  log.info(`Restarting interrupted classroom generation job ${jobId} (resume ${resumeCount + 1}).`);
  await updateClassroomGenerationJob(jobId, {
    status: 'queued',
    step: 'queued',
    progress: 0,
    scenesGenerated: 0,
    resumeCount: resumeCount + 1,
    message: 'Generation was interrupted; starting again',
  });
  void runClassroomGenerationJob(jobId, saved.input, saved.baseUrl);
  return true;
}

/**
 * Startup sweep: every job a previous process left queued or running. Jobs
 * that were still reporting moments ago are skipped here and picked up by the
 * status poll once they fall silent.
 */
export async function recoverInterruptedClassroomJobs(): Promise<number> {
  let restarted = 0;
  for (const jobId of await listClassroomGenerationJobIds()) {
    try {
      if (await recoverInterruptedClassroomJob(jobId)) restarted += 1;
    } catch (error) {
      log.warn(`Could not recover classroom generation job ${jobId}:`, error);
    }
  }
  return restarted;
}
