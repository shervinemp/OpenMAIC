import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { JsonFileDocumentStore } from '@openmaic/storage/server/file-document-store';
import type { MaicDocument } from '@openmaic/storage';
import { migrate } from '@openmaic/dsl';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createLogger } from '@/lib/logger';
import { listCourseBindings } from '@/lib/persistence/git-course-sync';
import { sha256Text } from '@/lib/server/document-index-store';

const log = createLogger('CourseGitImport');

/**
 * Inbound half of the course git sync: auto-LOAD courses from a bound git
 * repository and CHECK those courses for updates, with the approval gate and
 * configurability called "approval to update".
 *
 * Direction policy (the load-bearing design rule): the OUTBOUND scheduler
 * (git-course-sync.ts) commits the freshest persisted document into the repo;
 * the INBOUND side here never silently overwrites the persistence store.
 * Pull is always diff-first: an update lands only through an explicit apply
 * (or via the auto-apply env, which operators opt into, not into).
 *
 * Design constraints:
 * - Document shape: repository snapshots are the same documents JSON the
 *   outbound path commits (`{ stage, scenes, dslVersion, ... }`), so inbound
 *   import reuses the persistence store's own write boundary (validators,
 *   DSL version stamps). A repo file is never parsed into app state directly.
 * - Restore semantics: applying is a deliberate restore, so saves use
 *   `allowOlderOverwrite` (the repo snapshot is often older than tonight's
 *   autosave — that is exactly what "restore from repo" means).
 * - Remote pulls are OFF by default; only local repository paths are read
 *   unless COURSE_GIT_SYNC_ALLOW_REMOTE_FETCH is explicitly enabled.
 * - All failure modes fail soft: discovery/apply problems are logged and
 *   returned as per-stage results, never thrown into the caller.
 */

import { ingestRepoAssets } from '@/lib/persistence/git-sync-assets';

export interface RepoCourseSnapshot {
  repoPath: string;
  /** Sanitized file name without extension (outbound format). */
  stageFile: string;
  stageId: string;
  title: string;
  sceneCount: number;
  /** sha256 of the repo file contents (comparison key against persistence). */
  hash: string;
  mtimeMs: number;
}

export interface RepoCourseUpdateState extends RepoCourseSnapshot {
  state: 'new' | 'equal' | 'update' | 'invalid';
  /** Persistence-side only. */
  persistedHash?: string;
}

interface RepoDocumentShape {
  stage?: { id?: string; title?: string; name?: string; updatedAt?: number };
  scenes?: unknown[];
}

export function courseSnapshotFilename(stageId: string): string {
  return `${stageId.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`;
}

async function readRepoDocument(
  filePath: string,
): Promise<{ document: unknown; hash: string; mtimeMs: number } | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as RepoDocumentShape;
    if (!parsed?.stage || typeof parsed.stage.id !== 'string' || !Array.isArray(parsed.scenes)) {
      return null;
    }
    const info = await stat(filePath);
    return { document: parsed, hash: sha256Text(raw), mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

/** Read the persisted document file for a stage; null when missing/broken. */
async function readPersistedDocument(
  persistenceDir: string,
  stageId: string,
): Promise<{ hash: string } | null> {
  // The JsonFileDocumentStore URL-encodes stage ids into file names.
  const path = join(persistenceDir, 'documents', `${encodeURIComponent(stageId)}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    return { hash: coreHash(JSON.parse(raw)) };
  } catch {
    return null;
  }
}

/**
 * Key-order-independent JSON comparison key: the outbound scheduler stringifies
 * the document it serialized, while the persistence store writes its own
 * canonicalization (plus tmp-file atomicity rewrites) — byte equality between
 * the two writers is not meaningful, so state comparison compares the parsed
 * documents' sorted-key projection.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'dslVersion')
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Run the repo snapshot through the same DSL migration ladder the persistence
 * store runs on load, so "equal" means the SEMANTIC state matches (a repo
 * file written at an older DSL version that the store will migrate on first
 * read is not an update).
 */
function migratedCore(document: unknown): unknown {
  const parsed = document as { outline?: unknown; [key: string]: unknown };
  const { outline, ...core } = parsed as { outline?: unknown };
  void parsed;
  const migrated = migrateCore(core);
  return outline === undefined ? migrated : { ...(migrated as object), outline };
}

function migrateCore(core: unknown): unknown {
  return migrate(core as never) as unknown;
}

function coreHash(document: unknown): string {
  return sha256Text(canonicalJson(migratedCore(document)));
}

/** Every `*.json` course snapshot in every bound repository, newest first. */
export async function listRepoCourseSnapshots(
  persistenceDir: string,
): Promise<RepoCourseSnapshot[]> {
  const snapshots: RepoCourseSnapshot[] = [];
  // Several courses may share one repository: scan each repo ONCE, or every
  // snapshot in it would be listed (and applied) once per binding.
  const repoPaths = new Set(
    (await listCourseBindings(persistenceDir)).map((binding) => binding.repoPath),
  );
  for (const repoPath of repoPaths) {
    let names: string[];
    try {
      names = await readdir(repoPath);
    } catch (error) {
      log.warn(`Repo path ${JSON.stringify(repoPath)} is unreadable:`, error);
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const filePath = join(repoPath, name);
      const loaded = await readRepoDocument(filePath);
      if (!loaded) continue;
      const stage = (loaded.document as RepoDocumentShape).stage!;
      snapshots.push({
        repoPath,
        stageFile: name.slice(0, -'.json'.length),
        stageId: stage.id!,
        title: stage.title ?? stage.name ?? stage.id!,
        sceneCount: (loaded.document as RepoDocumentShape).scenes!.length,
        hash: coreHash(loaded.document),
        mtimeMs: loaded.mtimeMs,
      });
    }
  }
  return snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export type RepoCourseState = RepoCourseUpdateState['state'];

export interface RepoUpdateCheck {
  snapshot: RepoCourseSnapshot;
  state: RepoCourseState;
  persistedHash?: string;
}

/** Compare each repo snapshot against persistence: new / update / equal. */
export async function scanCourseUpdates(persistenceDir: string): Promise<RepoUpdateCheck[]> {
  const checks: RepoUpdateCheck[] = [];
  for (const snapshot of await listRepoCourseSnapshots(persistenceDir)) {
    const persisted = await readPersistedDocument(persistenceDir, snapshot.stageId);
    if (!persisted) {
      checks.push({ snapshot, state: 'new' });
      continue;
    }
    checks.push({
      snapshot,
      state: persisted.hash === snapshot.hash ? 'equal' : 'update',
      persistedHash: persisted.hash,
    });
  }
  return checks;
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
 * `git pull --ff-only` on every binding whose repo path is local, so the
 * snapshot scan sees fetch-time freshness. Off unless the env opt-in
 * (COURSE_GIT_SYNC_ALLOW_REMOTE_FETCH) says otherwise; never thrown.
 */
export async function pullBoundRepos(persistenceDir: string): Promise<void> {
  if (
    !['1', 'true'].includes(
      (process.env.COURSE_GIT_SYNC_ALLOW_REMOTE_FETCH ?? '').trim().toLowerCase(),
    )
  ) {
    return;
  }
  const repoPaths = new Set(
    (await listCourseBindings(persistenceDir)).map((binding) => binding.repoPath),
  );
  for (const repoPath of repoPaths) {
    try {
      await git(repoPath, ['pull', '--ff-only']);
    } catch (error) {
      log.warn(
        `pull for ${JSON.stringify(repoPath)} failed; using last fetched contents:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

export interface SyncStageResult {
  stageId: string;
  action: 'imported' | 'applied' | 'equal' | 'skipped' | 'rejected';
  detail: string;
}

export interface RunCourseGitSyncOptions {
  /** Apply 'update' candidates from the repo into persistence. */
  apply?: boolean;
  /** Auto-load 'new' courses (binding-level autoLoad gates this). */
  importNew?: boolean;
  /** Run `git pull` before scanning (env-gated remote access). */
  pull?: boolean;
  /**
   * Approval granularity: when set, apply/import only these stage ids —
   * everything else is left as-is (skipped), even when apply/importNew is on.
   */
  stageIds?: string[];
}

/** One sync run. Never throws; per-stage results are the contract. */
export async function runCourseGitSync(
  persistenceDir: string,
  options: RunCourseGitSyncOptions = {},
): Promise<{ results: SyncStageResult[] }> {
  if (options.pull) await pullBoundRepos(persistenceDir);
  const bindings = await listCourseBindings(persistenceDir);
  const autoLoadByRepo = new Set(
    bindings.filter((binding) => binding.autoLoad).map((binding) => binding.repoPath),
  );

  const store = new JsonFileDocumentStore({
    dir: persistenceDir,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });

  const results: SyncStageResult[] = [];
  for (const check of await scanCourseUpdates(persistenceDir)) {
    const { snapshot, state } = check;
    if (state === 'equal') {
      results.push({
        stageId: snapshot.stageId,
        action: 'equal',
        detail: 'repo and persistence are identical',
      });
      continue;
    }
    if (state === 'invalid') {
      results.push({
        stageId: snapshot.stageId,
        action: 'rejected',
        detail: 'repo snapshot is not a valid course document',
      });
      continue;
    }
    const isNew = state === 'new';
    const allowed =
      !options.stageIds ||
      options.stageIds.length === 0 ||
      options.stageIds.includes(snapshot.stageId);
    if (!allowed) {
      results.push({
        stageId: snapshot.stageId,
        action: 'skipped',
        detail: "outside this sync run's approval list",
      });
      continue;
    }
    if (isNew && (!options.importNew || !autoLoadByRepo.has(snapshot.repoPath))) {
      results.push({
        stageId: snapshot.stageId,
        action: 'skipped',
        detail: 'new course waiting for approval to import (autoLoad binding flag)',
      });
      continue;
    }
    if (!isNew && !options.apply) {
      results.push({
        stageId: snapshot.stageId,
        action: 'skipped',
        detail: 'update waiting for approval to apply',
      });
      continue;
    }

    const loaded = await readRepoDocument(join(snapshot.repoPath, `${snapshot.stageFile}.json`));
    if (!loaded) {
      results.push({
        stageId: snapshot.stageId,
        action: 'rejected',
        detail: 'repo snapshot disappeared mid-sync',
      });
      continue;
    }
    try {
      const document = loaded.document as unknown as MaicDocument;
      await store.saveDocument(document as never, { allowOlderOverwrite: true });
      // Materialize the repo's committed media payload into the server store
      // (manifest-driven: bytes next to the snapshot restore first; refs the
      // snapshot itself lacks are the honest remainder).
      const materials = await ingestRepoAssets(
        persistenceDir,
        snapshot.repoPath,
        snapshot.stageId,
        document,
      ).catch((error: unknown) => {
        log.warn(
          `Asset ingestion for ${JSON.stringify(snapshot.stageId)} failed:`,
          error instanceof Error ? error.message : error,
        );
        return null;
      });
      const bytesDetail =
        materials && materials.restored > 0
          ? ` (media rows restored: ${materials.restored}${materials.missingRefs.length > 0 ? `, ${materials.missingRefs.length} refs still missing` : ''})`
          : materials && materials.missingRefs.length > 0
            ? ` (${materials.missingRefs.length} refs missing bytes in the snapshot too)`
            : '';
      results.push({
        stageId: snapshot.stageId,
        action: isNew ? 'imported' : 'applied',
        detail:
          (isNew
            ? `imported "${(document.stage as { title?: string; name?: string }).title ?? (document.stage as { name?: string }).name ?? snapshot.stageId}" from repo`
            : 'repo snapshot restored over persisted course') + bytesDetail,
      });
      log.info(
        `Course ${snapshot.stageId} ${isNew ? 'imported' : 'restored'} from ${snapshot.repoPath}${bytesDetail}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({
        stageId: snapshot.stageId,
        action: 'rejected',
        detail: `save failed: ${detail}`,
      });
      log.warn(`Inbound apply for ${JSON.stringify(snapshot.stageId)} failed:`, detail);
    }
  }
  return { results };
}
