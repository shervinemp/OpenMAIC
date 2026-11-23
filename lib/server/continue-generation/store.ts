import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { writeJsonFileAtomic } from '@/lib/server/classroom-storage';

const log = createLogger('ContinueGenerationStore');

const CONTINUE_JOBS_DIR = process.env.CONTINUE_JOBS_DIR
  ? path.resolve(process.env.CONTINUE_JOBS_DIR)
  : path.join(process.cwd(), 'data', 'continue-jobs');

/** A lease must be renewed at least this often, or another worker may claim it. */
export const CONTINUE_LEASE_MS = 60_000;

export type ContinueJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ContinueJobInput {
  stageId: string;
  ownerId: string;
  includeFailed?: boolean;
  languageDirective?: string;
  userProfile?: string;
  taskEngineMode?: boolean;
  enableTTS?: boolean;
  /** Model/provider selection only — never credentials. */
  headers?: Record<string, string>;
  /** Server-relative base url used only for messages; no credentials here. */
  baseUrl: string;
}

export interface ContinueJob {
  id: string;
  status: ContinueJobStatus;
  stageId: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  scenesGenerated: number;
  scenesFailed: number;
  totalScenes?: number;
  resumeCount?: number;
  /** Worker that currently owns the lease, and when it expires. */
  workerId?: string;
  leaseExpiresAt?: number;
  heartbeatAt?: number;
  error?: string;
}

const locks = new Map<string, Promise<void>>();

async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(jobId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(jobId, prev.then(() => current));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (locks.get(jobId) === current) locks.delete(jobId);
  }
}

function jobPath(jobId: string): string {
  return path.join(CONTINUE_JOBS_DIR, `${jobId}.json`);
}

function inputPath(jobId: string): string {
  return path.join(CONTINUE_JOBS_DIR, `${jobId}.input.json`);
}

function lockPath(jobId: string): string {
  return path.join(CONTINUE_JOBS_DIR, `${jobId}.lock`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(CONTINUE_JOBS_DIR, { recursive: true });
}

export async function createContinueJob(
  jobId: string,
  input: ContinueJobInput,
): Promise<ContinueJob> {
  await ensureDir();
  const now = new Date().toISOString();
  const job: ContinueJob = {
    id: jobId,
    status: 'queued',
    stageId: input.stageId,
    message: 'Queued',
    createdAt: now,
    updatedAt: now,
    scenesGenerated: 0,
    scenesFailed: 0,
  };
  await writeJsonFileAtomic(jobPath(jobId), job);
  // Credentials are never part of this record — only model/provider selection.
  await writeJsonFileAtomic(inputPath(jobId), input);
  return job;
}

export async function readContinueJob(jobId: string): Promise<ContinueJob | null> {
  try {
    return JSON.parse(await fs.readFile(jobPath(jobId), 'utf-8')) as ContinueJob;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readContinueJobInput(jobId: string): Promise<ContinueJobInput | null> {
  try {
    return JSON.parse(await fs.readFile(inputPath(jobId), 'utf-8')) as ContinueJobInput;
  } catch {
    return null;
  }
}

export async function deleteContinueJobInput(jobId: string): Promise<void> {
  await fs.rm(inputPath(jobId), { force: true }).catch(() => undefined);
}

export async function updateContinueJob(
  jobId: string,
  patch: Partial<ContinueJob>,
): Promise<ContinueJob | null> {
  return withJobLock(jobId, async () => {
    const current = await readContinueJob(jobId);
    if (!current) return null;
    const next: ContinueJob = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFileAtomic(jobPath(jobId), next);
    return next;
  });
}

export async function listContinueJobIds(): Promise<string[]> {
  const names = await fs.readdir(CONTINUE_JOBS_DIR).catch(() => [] as string[]);
  return names
    .filter(
      (name) =>
        name.endsWith('.json') &&
        !name.endsWith('.input.json') &&
        !name.endsWith('.lock.json'),
    )
    .map((name) => name.slice(0, -'.json'.length));
}

/**
 * Atomically claim a job for a worker. The lock file is created exclusively;
 * only one worker can win. A stale lock (worker crashed) is removed and the
 * claim retried so a job left `running` can be recovered.
 */
export async function claimContinueJob(
  jobId: string,
  workerId: string,
  now = Date.now(),
): Promise<boolean> {
  await ensureDir();
  const existing = await readContinueJob(jobId);
  if (!existing || existing.status === 'cancelled' || existing.status === 'succeeded') return false;
  const file = lockPath(jobId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ workerId, claimedAt: now }));
      await handle.close();
      const job = await updateContinueJob(jobId, {
        status: 'running',
        workerId,
        leaseExpiresAt: now + CONTINUE_LEASE_MS,
        heartbeatAt: now,
        startedAt: (await readContinueJob(jobId))?.startedAt ?? new Date(now).toISOString(),
      });
      return !!job;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale = true;
      try {
        const owner = JSON.parse(await fs.readFile(file, 'utf-8')) as {
          workerId?: string;
          claimedAt?: number;
        };
        stale = !owner.workerId || now - (owner.claimedAt ?? 0) > CONTINUE_LEASE_MS;
      } catch {
        stale = true;
      }
      if (!stale) return false;
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
  }
  return false;
}

export async function releaseContinueJob(jobId: string, workerId: string): Promise<void> {
  try {
    const owner = JSON.parse(await fs.readFile(lockPath(jobId), 'utf-8')) as {
      workerId?: string;
    };
    if (owner.workerId !== workerId) return;
  } catch {
    return;
  }
  await fs.rm(lockPath(jobId), { force: true }).catch(() => undefined);
}

export async function renewContinueJobLease(
  jobId: string,
  workerId: string,
  now = Date.now(),
): Promise<boolean> {
  const job = await readContinueJob(jobId);
  if (!job || job.workerId !== workerId) return false;
  await updateContinueJob(jobId, {
    heartbeatAt: now,
    leaseExpiresAt: now + CONTINUE_LEASE_MS,
  });
  return true;
}

/** Jobs a worker may pick up: new ones, or running ones with an expired lease. */
export async function findClaimableContinueJobs(now = Date.now()): Promise<ContinueJob[]> {
  const ids = await listContinueJobIds();
  const jobs = await Promise.all(ids.map((id) => readContinueJob(id)));
  return jobs.filter((job): job is ContinueJob => {
    if (!job) return false;
    if (job.status === 'queued') return true;
    if (job.status !== 'running') return false;
    const lease = job.leaseExpiresAt ?? job.heartbeatAt ?? 0;
    return now > lease;
  });
}

/** Jobs a previous in-process runner left running (used by legacy recovery). */
export async function findInterruptedContinueJobs(): Promise<ContinueJob[]> {
  const ids = await listContinueJobIds();
  const jobs = await Promise.all(ids.map((id) => readContinueJob(id)));
  return jobs.filter((job): job is ContinueJob => !!job && job.status === 'running');
}

/** Cancellation is observed by the worker through the job record. */
export async function isContinueJobCancelled(jobId: string): Promise<boolean> {
  return (await readContinueJob(jobId))?.status === 'cancelled';
}

export function logContinueError(message: string, error: unknown): void {
  log.warn(message, error);
}
