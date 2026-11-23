import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { writeJsonFileAtomic } from '@/lib/server/classroom-storage';

const log = createLogger('ContinueGenerationStore');

const CONTINUE_JOBS_DIR = process.env.CONTINUE_JOBS_DIR
  ? path.resolve(process.env.CONTINUE_JOBS_DIR)
  : path.join(process.cwd(), 'data', 'continue-jobs');

export type ContinueJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ContinueJobInput {
  stageId: string;
  ownerId: string;
  includeFailed?: boolean;
  languageDirective?: string;
  userProfile?: string;
  taskEngineMode?: boolean;
  enableTTS?: boolean;
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
  // Credentials are never part of this record: they live only in the request
  // headers and are forwarded in memory to the generate APIs.
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
    .filter((name) => name.endsWith('.json') && !name.endsWith('.input.json'))
    .map((name) => name.slice(0, -'.json'.length));
}

/** Jobs left running by a process restart are eligible for recovery. */
export async function findInterruptedContinueJobs(): Promise<ContinueJob[]> {
  const ids = await listContinueJobIds();
  const jobs = await Promise.all(ids.map((id) => readContinueJob(id)));
  return jobs.filter((job): job is ContinueJob => !!job && job.status === 'running');
}

export function logContinueError(message: string, error: unknown): void {
  log.warn(message, error);
}
