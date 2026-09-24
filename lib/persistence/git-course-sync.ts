import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { createLogger } from '@/lib/logger';
import { materializeStageAssets, stageAssetDir } from '@/lib/persistence/git-sync-assets';

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
 * Cross-process repository write lock.
 *
 * In-process commits are already serialized (drain chain), but TWO server
 * processes (an old `next dev` still alive while a replacement starts — the
 * exact incident pattern that corrupted loose objects three times) each run
 * their own serialized chain, and two Interleaved `git add`/commit writers
 * race inside the same object database. `mkdir` is atomic, so a lock
 * DIRECTORY under `.git` arbitrates across processes; a stale lock (writer
 * crashed mid-commit) is stolen after a generous-age window so liveness is
 * guaranteed. Readers skip it: reads never mutate the object database.
 */

const GIT_LOCK_MAX_WAIT_MS = 120_000;
const GIT_LOCK_POLL_MS = 150;
const GIT_LOCK_STALE_MS = 10 * 60_000;

async function withRepositoryLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = join(repoPath, '.git', 'openmaic-git.lock');
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        // Stale steal: a crashed writer's lock cannot be waited out forever.
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > GIT_LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Gone between EEXIST and stat — re-acquire.
        continue;
      }
      if (Date.now() - startedAt > GIT_LOCK_MAX_WAIT_MS) {
        throw new Error(`repository lock wait exceeded for ${repoPath}`);
      }
      await new Promise((settle) => {
        setTimeout(settle, GIT_LOCK_POLL_MS);
      });
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
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
  // A relative path resolves against the server's working directory — i.e.
  // the OpenMAIC checkout itself — so a typo like "." or "courses" would
  // commit course snapshots into the app's own repository.
  if (!isAbsolute(repoPath)) {
    throw new Error(`repoPath must be an absolute path (got ${JSON.stringify(repoPath)})`);
  }
  if (resolve(repoPath) === resolve(process.cwd())) {
    throw new Error('repoPath must not be the OpenMAIC application directory');
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
  private readonly disabled: boolean;
  /** Repos where git-lfs provisioning already ran (per process lifetime). */
  private readonly lfsReady = new Set<string>();
  /** Repos where the missing-git-lfs warning already fired (log once, not per commit). */
  private readonly lfsWarned = new Set<string>();

  constructor(
    private readonly persistenceDir: string,
    options: { debounceMs?: number; push?: boolean; includeMedia?: boolean; disabled?: boolean } = {},
  ) {
    this.debounceMs = options.debounceMs ?? envDebounceMs() ?? DEFAULT_DEBOUNCE_MS;
    this.push = options.push ?? false;
    this.disabled = options.disabled ?? false;
    // Media rides along by default (the "full course" export); set
    // COURSE_GIT_SYNC_MEDIA=0 when the repo must stay document-only — e.g.
    // GitHub growth pressure or snapshot-smoke test runs.
    this.includeMedia =
      options.includeMedia ?? !['0', 'false'].includes(envFlag(process.env.COURSE_GIT_SYNC_MEDIA));
  }

  /** Queue a debounced commit for the stage. Never throws. */
  schedule(stageId: string, reason: string, snapshot: () => Promise<unknown>): void {
    if (this.disabled) return;
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
    if (this.disabled) return;
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

  /**
   * Idempotent git-lfs provisioning for the bound repository — the media
   * half of the pipeline. Without this, `assets/` would ride as plain git
   * blobs (multi-GB zlib objects per commit: slow, disk-hungry, and the
   * exact profile that once corrupted object files under write pressure).
   * With it, `git add` routes `assets/**` through the LFS clean filter:
   * bytes land in the content-addressed LFS store, history carries pointers.
   *
   * Runs once per repo per process; every step is safe to repeat. Failure is
   * soft: media still commits as plain blobs, with one honest warning.
   */
  private async ensureLfs(repoPath: string): Promise<boolean> {
    if (this.lfsReady.has(repoPath)) return true;
    try {
      await git(repoPath, ['lfs', 'version']);
    } catch {
      if (!this.lfsWarned.has(repoPath)) {
        this.lfsWarned.add(repoPath);
        log.warn(
          'git-lfs is not installed; media will commit as plain git objects. ' +
            'Install git-lfs (https://git-lfs.com) for lean, corruption-resistant snapshots.',
        );
      }
      return false;
    }
    try {
      // Repo-local filter config + hooks: `git add` then routes assets/**
      // through the LFS clean filter even on machines without a global install.
      await git(repoPath, ['lfs', 'install', '--local']);
      // Writes/updates the `assets/** filter=lfs` entry in .gitattributes;
      // idempotent when the pattern is already tracked.
      await git(repoPath, ['lfs', 'track', 'assets/**']);
      this.lfsReady.add(repoPath);
      log.info('git-lfs provisioned for course repository (assets/** tracked as LFS pointers)');
      return true;
    } catch (error) {
      log.warn(
        'git-lfs provisioning failed; media will commit as plain git objects:',
        error instanceof Error ? error.message : error,
      );
      return false;
    }
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
        [...byRepo.entries()].map(([repoPath, repoJobs]) =>
          this.commitSequentially(repoPath, repoJobs),
        ),
      );
    });
    // The drain chain must never hold a rejected promise: every later flush
    // chains on it, so one failed run (an unreadable bindings file, say)
    // would otherwise silently skip every commit until the process restarts.
    this.drain = run.catch((error: unknown) => {
      log.warn(
        'course git sync flush failed; pending commits will retry on the next write',
        error instanceof Error ? error.message : error,
      );
    });
    await this.drain;
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

  /**
   * One commit at a time within a repo; each job fails soft (log, drop). The
   * repo path comes from the partition step — re-reading the binding here
   * raced an unbind between the two reads into a null dereference.
   */
  private async commitSequentially(repoPath: string, jobs: readonly CommitJob[]): Promise<void> {
    for (const job of jobs) {
      try {
        // Cross-process lock: another server instance may hold the repo
        // concurrently (old dev server alive during a restart). In-process
        // serialization alone cannot protect against that pair.
        await withRepositoryLock(repoPath, () => this.commit(job, repoPath));
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
      // The course's media payload goes with it — a removal commit that
      // leaves assets/<stage>/ behind strands orphaned LFS objects forever.
      if (this.includeMedia) {
        await rm(join(repoPath, stageAssetDir(job.stageId)), { recursive: true, force: true });
      }
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
    // Media pipeline provisioning comes FIRST: the LFS clean filter must be
    // in place before `git add` touches assets/**, or the bytes would land
    // as plain zlib blobs in this commit.
    const lfsReady = this.includeMedia ? await this.ensureLfs(repoPath) : false;
    await git(repoPath, ['add', '--all', `${stageFile}.json`]);
    if (this.includeMedia) {
      if (lfsReady) {
        // Version the tracking file with the first media commit (idempotent
        // when already committed and unchanged).
        await git(repoPath, ['add', '--all', '.gitattributes']).catch(() => undefined);
      }
      // Track the materialized media payload with the snapshot (git-sync-assets
      // writes under assets/<stageId>/); the stage file's add --all above
      // cannot pull an untracked sibling directory in. With `assets/**`
      // tracked as git-lfs, this stages POINTERS — the bytes land in the LFS
      // store, never as zlib blobs.
      await git(repoPath, ['add', '--all', stageAssetDir(job.stageId)]).catch(() => undefined);
    }
    const statusPaths = [
      `${stageFile}.json`,
      ...(this.includeMedia ? [stageAssetDir(job.stageId)] : []),
      ...(lfsReady ? ['.gitattributes'] : []),
    ];
    const status = await git(repoPath, ['status', '--porcelain', ...statusPaths]);
    if (!status.stdout.trim()) return; // identical to the last commit
    const commitArgs = (fixedIdentity: boolean): string[] => [
      ...(fixedIdentity
        ? ['-c', 'user.name=OpenMAIC Course Sync', '-c', 'user.email=openmaic-course-sync@local']
        : []),
      '-c',
      'commit.gpgsign=false',
      'commit',
      // Media mode commits the STAGED index wholesale — the json, the staged
      // LFS asset pointers and .gitattributes alike. (`--only <json>` from
      // the document-only era silently left every staged asset uncommitted
      // forever: the media never reached history. `--include <json>` breaks
      // on the delete flow, where the json no longer exists.) Document-only
      // mode keeps the historical single-path commit.
      ...(this.includeMedia ? [] : ['--only', `${stageFile}.json`]),
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
      // Push by explicit remote + branch. A bare `git push` needs an upstream
      // (`branch.<n>.remote/merge`) configured in the repo; the course repo in
      // the wild only carries `remote.<n>.url`, so the bare form fails with a
      // misleading "no remote configured" after every commit. Resolve the
      // first remote and the current branch instead — explicit and safe.
      try {
        const remotes = (await git(repoPath, ['remote'])).stdout.split(/\r?\n/).filter(Boolean);
        if (remotes.length === 0) {
          log.warn('push skipped: the bound repository has no git remote configured');
        } else {
          const branch = (
            await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
          ).stdout.trim();
          const [remote] = remotes;
          const pushed = await git(repoPath, [
            'push',
            ...(branch && branch !== 'HEAD' ? [remote, branch] : [remote]),
          ]);
          if (pushed.stderr.trim()) {
            log.info(`push: ${pushed.stderr.trim()}`);
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log.warn(`push failed after commit: ${detail}`);
      }
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

/**
 * The snapshot writer is best-effort: COURSE_GIT_SYNC=0 disables it entirely
 * (a repository whose git layer intermittently corrupts objects can only
 * cost disk churn — the durable .data store holds the truth).
 */
const COURSE_GIT_SYNC_DISABLED = ['0', 'false'].includes(
  (process.env.COURSE_GIT_SYNC ?? '').trim().toLowerCase(),
);

export function getCourseGitScheduler(persistenceDir: string): CourseGitCommitScheduler {
  let scheduler = schedulers.get(persistenceDir);
  if (!scheduler) {
    const push = ['1', 'true'].includes(
      (process.env.COURSE_GIT_SYNC_PUSH ?? '').trim().toLowerCase(),
    );
    scheduler = new CourseGitCommitScheduler(persistenceDir, {
      debounceMs: envDebounceMs(),
      push,
      disabled: COURSE_GIT_SYNC_DISABLED,
    });
    schedulers.set(persistenceDir, scheduler);
  }
  return scheduler;
}
