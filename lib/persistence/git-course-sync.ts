import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createLogger } from '@/lib/logger';
import { materializeStageAssets } from '@/lib/persistence/git-sync-assets';

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
  /**
   * Inbound gating (git-course-import.ts): when true, the boot-time scanner
   * may auto-import NEW courses whose snapshots appear in `repoPath` (existing
   * bound stages never auto-restore; 'update' states always wait for an
   * explicit apply). Defaults to false — update checks stay passive.
   */
  autoLoad?: boolean;
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
  autoLoad?: boolean;
}): Promise<CourseRepositoryBinding> {
  const { persistenceDir, stageId } = options;
  const repoPath = options.repoPath.trim();
  if (!stageId || !repoPath) {
    throw new Error('stageId and repoPath are both required');
  }
  if (await getCourseBinding(persistenceDir, stageId)) {
    throw new CourseRepositoryAlreadyBoundError(stageId);
  }
  // Snapshot files are per-repo (one stage per file). Two bound stages whose
  // ids sanitize to the SAME file would overwrite each other's snapshots in a
  // shared repo — refuse that ambiguity at bind time instead of corrupting
  // history later.
  const stageFile = sanitizeStageFile(stageId);
  for (const existing of await readBindings(persistenceDir)) {
    if (
      existing.repoPath === repoPath &&
      sanitizeStageFile(existing.stageId) === stageFile
    ) {
      throw new Error(
        `stageId ${JSON.stringify(stageId)} would share the snapshot file ${JSON.stringify(stageFile + '.json')} ` +
          `with bound stage ${JSON.stringify(existing.stageId)} in the same repository; use a distinct id`,
      );
    }
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
  const binding: CourseRepositoryBinding = {
    stageId,
    repoPath,
    boundAt: Date.now(),
    ...(options.autoLoad === undefined ? {} : { autoLoad: !!options.autoLoad }),
  };
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
  kind: 'upsert' | 'delete';
  stageId: string;
  reason: string;
  /** Returns the freshest document at commit time (null → delete semantics). */
  snapshot: () => Promise<unknown>;
}

export class CourseGitCommitScheduler {
  private pending = new Map<string, CommitJob>();
  private timer: NodeJS.Timeout | null = null;
  private drain: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;
  private readonly push: boolean;
  private readonly includeMedia: boolean;

  constructor(
    private readonly persistenceDir: string,
    options: { debounceMs?: number; push?: boolean; includeMedia?: boolean } = {},
  ) {
    this.debounceMs = options.debounceMs ?? envDebounceMs() ?? DEFAULT_DEBOUNCE_MS;
    this.push = options.push ?? false;
    // Media rides along by default (the "full course" export); set
    // COURSE_GIT_SYNC_MEDIA=0 when the repo must stay document-only — e.g.
    // GitHub growth pressure or snapshot-smoke test runs.
    this.includeMedia =
      options.includeMedia ?? !['0', 'false'].includes(envFlag(process.env.COURSE_GIT_SYNC_MEDIA));
  }

  /** Queue a debounced commit for the stage. Never throws. */
  schedule(stageId: string, reason: string, snapshot: () => Promise<unknown>): void {
    this.pending.set(stageId, { kind: 'upsert', stageId, reason, snapshot });
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Queue a debounced REMOVAL commit: the repo drops the stage's snapshot. */
  scheduleDelete(stageId: string, reason: string): void {
    this.pending.set(stageId, {
      kind: 'delete',
      stageId,
      reason,
      snapshot: async () => null,
    });
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
    const run = this.drain.then(async () => {
      // Resolve bindings up front and partition by repo: two stages in the
      // SAME repo must commit one after another (git is single-writer per
      // worktree — a parallel pair would collide on the index lock), while
      // distinct repos stay independent.
      const byRepo = await this.partitionByRepo(jobs);
      await Promise.all(
        [...byRepo.values()].map((jobs) => this.commitSequentially(jobs)),
      );
    });
    this.drain = run;
    await run;
  }

  private async partitionByRepo(
    jobs: readonly CommitJob[],
  ): Promise<Map<string, CommitJob[]>> {
    const byRepo = new Map<string, CommitJob[]>();
    for (const job of jobs) {
      const binding = await getCourseBinding(this.persistenceDir, job.stageId);
      if (!binding) continue; // unbound: nothing to sync
      const queued = byRepo.get(binding.repoPath);
      if (queued) queued.push(job);
      else byRepo.set(binding.repoPath, [job]);
    }
    return byRepo;
  }

  /** One commit at a time within a repo; each job fails soft (log, drop). */
  private async commitSequentially(jobs: readonly CommitJob[]): Promise<void> {
    const repoPath = (await getCourseBinding(this.persistenceDir, jobs[0].stageId))!.repoPath;
    for (const job of jobs) {
      try {
        await this.commit(job, repoPath);
      } catch (error) {
        log.warn(
          `git commit for ${JSON.stringify(job.stageId)} failed (${job.reason}); ` +
            'retrying on the next write',
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  private async commit(job: CommitJob, repoPath: string): Promise<void> {
    const stageFile = sanitizeStageFile(job.stageId);
    const target = join(repoPath, `${stageFile}.json`);
    if (job.kind === 'delete') {
      await rm(target, { force: true });
    } else {
      const document = await job.snapshot();
      if (document === null || document === undefined) return; // deleted mid-window
      await mkdir(repoPath, { recursive: true });
      await writeFile(target, JSON.stringify(document), 'utf8');
      // Full-course snapshot: media the server can resolve rides along (see
      // git-sync-assets.ts). Unresolvable refs are listed in the stage's
      // manifest — the browser backfill uploader supplies those bytes first;
      // copy is best-effort and never fails the commit.
      if (this.includeMedia) {
        await materializeStageAssets(
          this.persistenceDir,
          repoPath,
          job.stageId,
          document,
        ).catch((error) => {
          log.warn(`Asset materialization for ${JSON.stringify(job.stageId)} failed; committing document only:`, error instanceof Error ? error.message : error);
        });
      }
    }
    await git(repoPath, ['add', '--all', `${stageFile}.json`]);
    const status = await git(repoPath, ['status', '--porcelain', `${stageFile}.json`]);
    if (!status.stdout.trim()) return; // identical to the last commit
    const commitArgs = (fixedIdentity: boolean): string[] => [
      ...(fixedIdentity
        ? ['-c', 'user.name=OpenMAIC Course Sync', '-c', 'user.email=openmaic-course-sync@local']
        : []),
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--only',
      `${stageFile}.json`,
      '-m',
      `openmaic(${stageFile}): ${job.reason}`,
    ];
    try {
      await git(repoPath, commitArgs(false));
    } catch {
      // No git identity configured on this machine — fall back to a fixed
      // sync identity rather than dropping the commit (the user can re-own
      // the commit with `git commit --amend --reset-author`).
      await git(repoPath, commitArgs(true));
    }
    if (this.push) {
      await git(repoPath, ['push']).catch(() => {
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

function envFlag(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
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
