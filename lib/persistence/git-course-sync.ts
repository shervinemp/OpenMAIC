import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createLogger } from '@/lib/logger';

const log = createLogger('CourseGitSync');

/**
 * Tie a course (a persistence stage) to a git repository so the course is
 * versioned automatically as it generates.
 *
 * Design:
 * - Bindings are per stageId and live in `<PERSISTENCE_DIR>/course-git/bindings.json`.
 * - Each commit writes the freshest document snapshot into the repo at
 *   `<repoPath>/<stageId>.json` and commits it with a conventional message.
 *   The repo stays ordinary — any git client can diff or restore it.
 * - Commits are debounced per stage (generation is chatty: several writes land
 *   within seconds of each other) and globally serial (one git invocation at a
 *   time).
 * - Sync failures NEVER propagate into the persistence write path: the course
 *   save has already succeeded; a failed snapshot/commit is logged and retried
 *   on the next schedule. History is therefore best-effort, and the durable
 *   source of truth remains the persistence store.
 */

const DEFAULT_DEBOUNCE_MS = 4_000;
const BINDINGS_FILE = 'bindings.json';

export interface CourseRepositoryBinding {
  stageId: string;
  repoPath: string;
  boundAt: number;
}

interface BindingFile {
  version: 1;
  bindings: CourseRepositoryBinding[];
}

export class CourseRepositoryAlreadyBoundError extends Error {
  constructor(readonly stageId: string) {
    super(`stage ${JSON.stringify(stageId)} is already bound to a git repository`);
    this.name = 'CourseRepositoryAlreadyBoundError';
  }
}

function bindingsPath(persistenceDir: string): string {
  return join(persistenceDir, 'course-git', BINDINGS_FILE);
}

export function sanitizeStageFile(stageId: string): string {
  return stageId.replace(/[^A-Za-z0-9._-]+/g, '_');
}

async function readBindings(persistenceDir: string): Promise<CourseRepositoryBinding[]> {
  try {
    const raw = await readFile(bindingsPath(persistenceDir), 'utf8');
    const parsed = JSON.parse(raw) as BindingFile;
    return Array.isArray(parsed?.bindings) ? parsed.bindings : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeBindings(
  persistenceDir: string,
  bindings: CourseRepositoryBinding[],
): Promise<void> {
  await mkdir(join(persistenceDir, 'course-git'), { recursive: true });
  const payload: BindingFile = { version: 1, bindings };
  await writeFile(bindingsPath(persistenceDir), JSON.stringify(payload, null, 2), 'utf8');
}

export function listCourseBindings(persistenceDir: string): Promise<CourseRepositoryBinding[]> {
  return readBindings(persistenceDir);
}

export function getCourseBinding(
  persistenceDir: string,
  stageId: string,
): Promise<CourseRepositoryBinding | null> {
  return readBindings(persistenceDir).then(
    (bindings) => bindings.find((binding) => binding.stageId === stageId) ?? null,
  );
}

function git(
  workdir: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: workdir, timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/**
 * Bind one course to a repo. `init` creates a fresh git repository when the
 * path is not already one; otherwise the path must already be a repo.
 */
export async function bindCourseRepository(options: {
  persistenceDir: string;
  stageId: string;
  repoPath: string;
  init?: boolean;
}): Promise<CourseRepositoryBinding> {
  const { persistenceDir, stageId } = options;
  const repoPath = options.repoPath.trim();
  if (!stageId || !repoPath) {
    throw new Error('stageId and repoPath are both required');
  }
  if (await getCourseBinding(persistenceDir, stageId)) {
    throw new CourseRepositoryAlreadyBoundError(stageId);
  }
  await mkdir(repoPath, { recursive: true });
  try {
    await readFile(join(repoPath, '.git', 'HEAD'), 'utf8');
  } catch {
    if (!options.init) {
      throw new Error(`${repoPath} is not a git repository (pass init=true to create one)`);
    }
    await git(repoPath, ['init']);
  }
  const binding: CourseRepositoryBinding = { stageId, repoPath, boundAt: Date.now() };
  const bindings = (await readBindings(persistenceDir)).filter(
    (binding) => binding.stageId !== stageId,
  );
  bindings.push(binding);
  await writeBindings(persistenceDir, bindings);
  return binding;
}

export async function unbindCourseRepository(
  persistenceDir: string,
  stageId: string,
): Promise<boolean> {
  const bindings = await readBindings(persistenceDir);
  const next = bindings.filter((binding) => binding.stageId !== stageId);
  if (next.length === bindings.length) return false;
  await writeBindings(persistenceDir, next);
  return true;
}

interface CommitJob {
  stageId: string;
  reason: string;
  /** Returns the freshest document at commit time (null → nothing to commit). */
  snapshot: () => Promise<unknown>;
}

export class CourseGitCommitScheduler {
  private pending = new Map<string, CommitJob>();
  private timer: NodeJS.Timeout | null = null;
  private drain: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;
  private readonly push: boolean;

  constructor(
    private readonly persistenceDir: string,
    options: { debounceMs?: number; push?: boolean } = {},
  ) {
    this.debounceMs = options.debounceMs ?? envDebounceMs() ?? DEFAULT_DEBOUNCE_MS;
    this.push = options.push ?? false;
  }

  /** Queue a debounced commit for the stage. Never throws. */
  schedule(stageId: string, reason: string, snapshot: () => Promise<unknown>): void {
    this.pending.set(stageId, { stageId, reason, snapshot });
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Await any queued commits immediately (flush; used by tests and teardown). */
  async flushForTesting(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    const jobs = [...this.pending.values()];
    this.pending.clear();
    const run = this.drain.then(
      async () =>
        void (await Promise.all(
          jobs.map((job) =>
            this.commit(job).catch((error) => {
              log.warn(
                `git commit for ${JSON.stringify(job.stageId)} failed (${job.reason}); ` +
                  'retrying on the next write',
                error instanceof Error ? error.message : error,
              );
            }),
          ),
        )),
    );
    this.drain = run;
    await run;
  }

  private async commit(job: CommitJob): Promise<void> {
    const binding = await getCourseBinding(this.persistenceDir, job.stageId);
    if (!binding) return; // unbound between schedule and flush — nothing to do
    const document = await job.snapshot();
    if (document === null || document === undefined) return;
    const stageFile = sanitizeStageFile(job.stageId);
    const target = join(binding.repoPath, `${stageFile}.json`);
    await mkdir(binding.repoPath, { recursive: true });
    await writeFile(target, JSON.stringify(document), 'utf8');
    await git(binding.repoPath, ['add', '--all', `${stageFile}.json`]);
    const status = await git(binding.repoPath, ['status', '--porcelain', `${stageFile}.json`]);
    if (!status.stdout.trim()) return; // snapshot identical to the last commit
    const commitArgs = (identity: boolean): string[] => [
      ...(!identity ? [] : ['-c', 'user.name=OpenMAIC Course Sync', '-c', 'user.email=openmaic-course-sync@local']),
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--only',
      `${stageFile}.json`,
      '-m',
      `openmaic(${stageFile}): ${job.reason}`,
    ];
    try {
      await git(binding.repoPath, commitArgs(false));
    } catch {
      // No git identity configured on this machine — fall back to a fixed
      // sync identity rather than dropping the commit (README caveat: the
      // user can re-set their own identity with `git commit --amend`).
      await git(binding.repoPath, commitArgs(true));
    }
    if (this.options.push) {
      await git(binding.repoPath, ['push']).catch(() => {
        log.warn('push failed after commit (no remote configured or auth required)');
      });
    }
  }
}

function envDebounceMs(): number | undefined {
  const raw = process.env.COURSE_GIT_SYNC_DEBOUNCE_MS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * One scheduler per persistence dir per process. Route modules call this on
 * every request, so the module-scoped map guarantees at-most-one timer.
 */
const schedulers = new Map<string, CourseGitCommitScheduler>();

export function getCourseGitScheduler(persistenceDir: string): CourseGitCommitScheduler {
  let scheduler = schedulers.get(persistenceDir);
  if (!scheduler) {
    const push = ['1', 'true'].includes(
      (process.env.COURSE_GIT_SYNC_PUSH ?? '').trim().toLowerCase(),
    );
    scheduler = new CourseGitCommitScheduler(persistenceDir, { debounceMs: envDebounceMs(), push });
    schedulers.set(persistenceDir, scheduler);
  }
  return scheduler;
}
