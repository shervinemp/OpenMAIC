/**
 * JsonFileDocumentStore — a zero-dependency, single-user `DocumentStore`
 * backend that persists one JSON file per document on local disk.
 *
 * This is the localhost answer to the storage RFC's "the pluggable seam is the
 * backend, not the database driver" line: the HTTP contract and the client
 * `HttpDocumentStore` are unchanged; only the server-side store differs from
 * the Postgres backend. Files live at `<dir>/documents/<encoded-stageId>.json`
 * and hold the whole `MaicDocument` aggregate, so a lesson is a single portable
 * JSON file that survives browser origin changes, port rotation, or profile
 * wipes — the entire point of server-backed persistence for a self-hosted app.
 *
 * Contract fidelity with the other backends:
 * - Writes validate the aggregate (stage + every scene + storable-scene
 *   invariants) and refuse future-versioned data, exactly like
 *   `BrowserDocumentStore`.
 * - Reads migrate the aggregate forward on the DSL ladder (outline excluded,
 *   as elsewhere).
 * - Incremental writes (`putStage` / `putScene` / `deleteScene`) require the
 *   stored document to be at the current DSL version (never downgrade a newer
 *   document, never mutate a stale one before a full load + save).
 * - `listDocuments` tolerates a corrupt file by omission, matching the
 *   "one poison row must not break the whole listing" precedent.
 *
 * Durability: every write goes through a temp file + atomic rename, so a
 * crash mid-write leaves either the old or the new aggregate, never a torn
 * file. Concurrency: incremental writes are read-modify-write, so requests
 * for the SAME document are serialized in-process (two classroom tabs, or a
 * maintenance pass racing a classroom save, otherwise lose updates and race
 * the rename — the Windows EPERM storm). Cross-process contention still
 * relies on the bounded rename retry below.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DSL_VERSION,
  DSL_VERSION_KEY,
  dslVersionOf,
  migrate,
  needsMigration,
  validateScene,
  validateStage,
} from '@openmaic/dsl';
import type { Scene, Stage } from '@openmaic/dsl';

import type {
  DocumentStore,
  DocumentSummary,
  MaicDocument,
  SaveDocumentOptions,
  SceneLike,
  SceneValidator,
  StageValidator,
} from '../document/types.js';
import {
  DocumentLostUpdateError,
  DocumentNotFoundError,
  DocumentVersionError,
  isStaleOverwrite,
} from '../document/types.js';

export interface JsonFileDocumentStoreOptions<
  TScene extends SceneLike = Scene,
  TStage extends Stage = Stage,
> {
  /** Root directory; the `documents/` subdirectory is created on demand. */
  dir: string;
  /** Scene validator at the write boundary. Defaults to the DSL `validateScene`. */
  validateScene?: SceneValidator;
  /** Stage validator at the write boundary. Defaults to the DSL `validateStage`. */
  validateStage?: StageValidator;
}

/**
 * Per-document write mutex (in-process, module-scoped so it spans the
 * short-lived store instances each request constructs). Incremental writes
 * are read-modify-write: interleaved requests lose updates AND race the
 * rename (EPERM/EACCES on Windows). The chain serializes those critical
 * sections per document path; `writeAtomic`'s retry covers the residual
 * cross-process / external-reader contention.
 */
const documentWriteLocks = new Map<string, Promise<unknown>>();

function withDocumentWriteLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = documentWriteLocks.get(path) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  documentWriteLocks.set(path, tail);
  void tail.then(() => {
    if (documentWriteLocks.get(path) === tail) documentWriteLocks.delete(path);
  });
  return run;
}

function assertValid(result: ReturnType<StageValidator>, label: string): void {
  if (result.valid) return;
  const detail = result.errors.map((e) => `${e.path || '/'}: ${e.message}`).join('; ');
  throw new Error(`@openmaic/storage: invalid ${label}: ${detail}`);
}

function assertStorableScene(scene: SceneLike, stageId: string): void {
  const value = scene as { id: unknown; stageId: unknown; order: unknown };
  if (typeof value.id !== 'string') {
    throw new Error(
      `@openmaic/storage: scene id must be a string, got ${JSON.stringify(value.id)}`,
    );
  }
  if (value.stageId !== stageId) {
    throw new Error(
      `@openmaic/storage: scene ${JSON.stringify(value.id)} has stageId ` +
        `${JSON.stringify(value.stageId)} but belongs to document ${JSON.stringify(stageId)}`,
    );
  }
  if (typeof value.order !== 'number' || !Number.isFinite(value.order)) {
    throw new Error(
      `@openmaic/storage: scene ${JSON.stringify(value.id)} order must be a finite number, got ` +
        `${JSON.stringify(value.order)}`,
    );
  }
}

function isFutureVersioned(versioned: unknown): boolean {
  if (typeof versioned !== 'object' || versioned === null) return false;
  return !needsMigration(versioned) && dslVersionOf(versioned) !== DSL_VERSION;
}

function migrateDocument<TScene extends SceneLike, TStage extends Stage>(
  document: MaicDocument<TScene, TStage>,
): MaicDocument<TScene, TStage> {
  const { outline, ...core } = document;
  const migrated = migrate(core) as MaicDocument<TScene, TStage>;
  return outline === undefined ? migrated : { ...migrated, outline };
}

/** URL-encode stage ids for the filesystem; `.` and `..` can never appear. */
function fileName(stageId: string): string {
  return encodeURIComponent(stageId);
}

export class JsonFileDocumentStore<
  TScene extends SceneLike = Scene,
  TStage extends Stage = Stage,
> implements DocumentStore<TScene, TStage> {
  private readonly root: string;
  private readonly validateSceneFn: SceneValidator;
  private readonly validateStageFn: StageValidator;

  constructor(options: JsonFileDocumentStoreOptions<TScene, TStage>) {
    this.root = options.dir;
    this.validateSceneFn = options.validateScene ?? validateScene;
    this.validateStageFn = options.validateStage ?? validateStage;
  }

  private documentDir(): string {
    return join(this.root, 'documents');
  }

  private documentPath(stageId: string): string {
    return join(this.documentDir(), `${fileName(stageId)}.json`);
  }

  private withDocumentLock<T>(stageId: string, task: () => Promise<T>): Promise<T> {
    return withDocumentWriteLock(this.documentPath(stageId), task);
  }

  private async readStored(stageId: string): Promise<MaicDocument<TScene, TStage> | null> {
    try {
      const raw = await readFile(this.documentPath(stageId), 'utf8');
      return JSON.parse(raw) as MaicDocument<TScene, TStage>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async writeAtomic(stageId: string, document: unknown): Promise<void> {
    await mkdir(this.documentDir(), { recursive: true });
    const path = this.documentPath(stageId);
    // Windows (EPERM/EACCES/EBUSY on rename while a concurrent reader or the
    // git-scheduler holds the target open) is a transient race, not a data
    // failure: back off briefly and retry before giving up. Bounded — a lock
    // held longer than ~3s is a real fault worth surfacing.
    // Orphan sweep: crash-dying writers leave `.tmp-*` shells beside the
    // target (each a full document-sized temp). An unchecked pile of them
    // once filled the disk and took the whole pipeline down (ENOSPC on every
    // write). Bounded best-effort sweep: patterns we own, older than 1
    // minute — a live writer's tmp is younger than that.
    try {
      const dir = this.documentDir();
      const listing = await readdir(dir).catch(() => [] as string[]);
      const cutoff = Date.now() - 60_000;
      for (const name of listing) {
        if (!name.startsWith(`${fileName(stageId)}.json.tmp-`)) continue;
        const meta = await stat(join(dir, name)).catch(() => null);
        if (meta && meta.mtimeMs < cutoff) {
          await rm(join(dir, name), { force: true }).catch(() => undefined);
        }
      }
    } catch {
      // hygiene is best-effort; never block the write path
    }
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
      try {
        await writeFile(tmp, JSON.stringify(document), 'utf8');
        await rename(tmp, path);
        return;
      } catch (error) {
        try {
          await rm(tmp, { force: true });
        } catch {
          // best effort cleanup
        }
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (['EPERM', 'EACCES', 'EBUSY'].includes(code) && attempt < maxAttempts) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(150 * 2 ** (attempt - 1), 1200)),
          );
          continue;
        }
        throw error;
      }
    }
  }

  private async removeFile(stageId: string): Promise<void> {
    try {
      await rm(this.documentPath(stageId), { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private assertCurrentForIncrementalWrite(
    stageId: string,
    stored: MaicDocument<TScene, TStage>,
  ): void {
    if (isFutureVersioned(stored)) {
      throw new DocumentVersionError(
        stageId,
        'future',
        stored.dslVersion,
        `@openmaic/storage: cannot mutate document ${JSON.stringify(stageId)} — the stored ` +
          `copy is at DSL version ${JSON.stringify(dslVersionOf(stored))}, newer than this ` +
          `client's ${DSL_VERSION}`,
      );
    }
    if (dslVersionOf(stored) !== DSL_VERSION) {
      throw new DocumentVersionError(
        stageId,
        'not-current',
        stored.dslVersion,
        `@openmaic/storage: cannot incrementally mutate document ${JSON.stringify(stageId)} at ` +
          `DSL version ${JSON.stringify(dslVersionOf(stored))} — load and save it to bring it to ` +
          `${DSL_VERSION} first`,
      );
    }
  }

  async saveDocument(
    document: MaicDocument<TScene, TStage>,
    options?: SaveDocumentOptions,
  ): Promise<void> {
    if (isFutureVersioned(document)) {
      throw new DocumentVersionError(
        document.stage.id,
        'future',
        document.dslVersion,
        `@openmaic/storage: refusing to save document ${JSON.stringify(document.stage.id)} — it ` +
          `was written at DSL version ${JSON.stringify(dslVersionOf(document))}, newer than this ` +
          `client's ${DSL_VERSION}`,
      );
    }
    const normalized = migrateDocument(document);
    assertValid(this.validateStageFn(normalized.stage), `stage ${normalized.stage.id}`);
    const stageId = normalized.stage.id;
    const seen = new Set<string>();
    for (const scene of normalized.scenes) {
      assertValid(this.validateSceneFn(scene), `scene ${scene.id}`);
      assertStorableScene(scene, stageId);
      if (seen.has(scene.id)) {
        throw new Error(
          `@openmaic/storage: duplicate scene id ${JSON.stringify(scene.id)} in document ` +
            JSON.stringify(stageId),
        );
      }
      seen.add(scene.id);
    }
    await this.withDocumentLock(stageId, async () => {
      const stored = await this.readStored(stageId);
      if (stored && isFutureVersioned(stored)) {
        throw new DocumentVersionError(
          stageId,
          'future',
          stored.dslVersion,
          `@openmaic/storage: refusing to overwrite document ${JSON.stringify(stageId)} — the ` +
            `stored copy is at DSL version ${JSON.stringify(dslVersionOf(stored))}, newer than this ` +
            `client's ${DSL_VERSION}`,
        );
      }
      // Lost-update fence: the stored copy is newer than the incoming save, so a
      // concurrent writer (another tab, another browser profile pointed at this
      // disk, a replayed client) moved the document forward. Refuse rather than
      // silently clobber newer content; deliberate wholesale restores pass
      // `allowOlderOverwrite`.
      if (!options?.allowOlderOverwrite && isStaleOverwrite(stored, document)) {
        throw new DocumentLostUpdateError(
          stageId,
          stored!.stage.updatedAt,
          document.stage.updatedAt,
          `@openmaic/storage: refusing to overwrite document ${JSON.stringify(stageId)} — the ` +
            `stored copy is newer (${JSON.stringify(stored!.stage.updatedAt)}) than the ` +
            `incoming save (${JSON.stringify(document.stage.updatedAt)}); reload and retry, or ` +
            'pass allowOlderOverwrite for a deliberate restore',
        );
      }
      await this.writeAtomic(stageId, { ...normalized, dslVersion: DSL_VERSION });
    });
  }

  async loadDocument(stageId: string): Promise<MaicDocument<TScene, TStage> | null> {
    const stored = await this.readStored(stageId);
    if (stored === null) return null;
    const migrated = migrateDocument(stored);
    return { ...migrated, scenes: [...migrated.scenes].sort((a, b) => a.order - b.order) };
  }

  async listDocuments(): Promise<DocumentSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.documentDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const summaries: DocumentSummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.json') || file.includes('.tmp-')) continue;
      try {
        const raw = await readFile(join(this.documentDir(), file), 'utf8');
        const document = JSON.parse(raw) as MaicDocument<TScene, TStage>;
        const stage = document.stage as TStage & {
          id: string;
          name: string;
          description?: string;
          interactiveMode?: boolean;
          taskEngineMode?: boolean;
          createdAt: number;
          updatedAt: number;
        };
        if (typeof stage?.id !== 'string' || typeof stage.name !== 'string') continue;
        summaries.push({
          id: stage.id,
          name: stage.name,
          description: stage.description,
          interactiveMode: stage.interactiveMode,
          taskEngineMode: stage.taskEngineMode,
          createdAt: stage.createdAt,
          updatedAt: stage.updatedAt,
          sceneCount: Array.isArray(document.scenes) ? document.scenes.length : 0,
        });
      } catch (error) {
        console.warn(`@openmaic/storage: skipping corrupt document file ${file}`, error);
      }
    }
    return summaries;
  }

  async deleteDocument(stageId: string): Promise<void> {
    await this.withDocumentLock(stageId, () => this.removeFile(stageId));
  }

  async putStage(stageId: string, stage: TStage): Promise<void> {
    assertValid(this.validateStageFn(stage), `stage ${stage.id}`);
    if (stage.id !== stageId) {
      throw new Error(
        `@openmaic/storage: stage ${JSON.stringify(stage.id)} does not belong to document ` +
          JSON.stringify(stageId),
      );
    }
    await this.withDocumentLock(stageId, async () => {
      const stored = await this.readStored(stageId);
      if (stored === null) {
        throw new DocumentNotFoundError(
          stageId,
          `@openmaic/storage: cannot putStage into missing document ${JSON.stringify(stageId)}`,
        );
      }
      this.assertCurrentForIncrementalWrite(stageId, stored);
      // The stage clock is monotonic: a stage write may never move
      // `updatedAt` BACKWARD. A stale tab's heartbeat used to lower it below
      // a maintenance write's revision, which disarmed the saveDocument
      // lost-update fence and let the tab's next full save clobber repaired
      // content. Max(stored, incoming) keeps the clock at the newest value
      // either writer has seen.
      const storedUpdatedAt = Number(stored.stage.updatedAt) || 0;
      const incomingUpdatedAt = Number(stage.updatedAt) || 0;
      await this.writeAtomic(stageId, {
        ...stored,
        stage: {
          ...stage,
          updatedAt: Math.max(storedUpdatedAt, incomingUpdatedAt),
          [DSL_VERSION_KEY]: DSL_VERSION,
        },
      });
    });
  }

  async putScene(stageId: string, scene: TScene): Promise<void> {
    assertValid(this.validateSceneFn(scene), `scene ${scene.id}`);
    assertStorableScene(scene, stageId);
    await this.withDocumentLock(stageId, async () => {
      const stored = await this.readStored(stageId);
      if (stored === null) {
        throw new DocumentNotFoundError(
          stageId,
          `@openmaic/storage: cannot putScene into missing document ${JSON.stringify(stageId)}`,
        );
      }
      this.assertCurrentForIncrementalWrite(stageId, stored);
      // Stale-scene fence: two tabs hold the same scene and one of them was
      // repaired meanwhile. The stale copy (older `updatedAt`) must not
      // overwrite the newer one. Equal timestamps pass (idempotent re-write
      // of an unchanged scene); newer content always wins.
      const existing = stored.scenes.find((s) => s.id === scene.id) as
        | { updatedAt?: unknown }
        | undefined;
      const storedSceneUpdatedAt = Number(existing?.updatedAt) || 0;
      const incomingUpdatedAt = Number((scene as { updatedAt?: unknown }).updatedAt) || 0;
      if (existing && incomingUpdatedAt < storedSceneUpdatedAt) {
        throw new DocumentLostUpdateError(
          stageId,
          storedSceneUpdatedAt,
          incomingUpdatedAt,
          `@openmaic/storage: refusing stale scene write ${JSON.stringify(scene.id)} in document ` +
            `${JSON.stringify(stageId)} — the stored copy is newer ` +
            `(${storedSceneUpdatedAt}) than the incoming write (${incomingUpdatedAt}); reload and retry`,
        );
      }
      const scenes = stored.scenes.map((s) => (s.id === scene.id ? scene : s));
      if (!scenes.some((s) => s.id === scene.id)) scenes.push(scene);
      // Move the stage's updatedAt forward: every incremental write is a newer
      // document revision, and the lost-update fence on saveDocument keys on
      // stage.updatedAt. Without this bump, a stale full-document save (an open
      // tab replaying an old snapshot) is not detected as stale and silently
      // clobbers this write — the demonic resurrection we traced in the SCD
      // lesson's canvases.
      const stage = { ...stored.stage, updatedAt: Date.now() };
      await this.writeAtomic(stageId, { ...stored, stage, scenes });
    });
  }

  async putPhaseStates(
    stageId: string,
    entries: ReadonlyArray<{
      outlineId: string;
      phase: string;
      status: string;
      attempts: number;
      updatedAt: number;
      error?: string;
    }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    await this.withDocumentLock(stageId, async () => {
      const stored = await this.readStored(stageId);
      if (stored === null) return;
      this.assertCurrentForIncrementalWrite(stageId, stored);
      const outline = (stored.outline ?? {}) as {
        lessonGroups?: Array<{
          jobs?: Array<{ outlineId: string; phases?: Record<string, unknown> }>;
        }>;
      };
      let touched = 0;
      for (const entry of entries) {
        for (const group of outline.lessonGroups ?? []) {
          const job = (group.jobs ?? []).find((job) => job.outlineId === entry.outlineId);
          if (!job) continue;
          job.phases = {
            ...(job.phases ?? {}),
            [entry.phase]: {
              status: entry.status,
              attempts: entry.attempts,
              updatedAt: entry.updatedAt,
              ...(entry.error ? { error: entry.error } : {}),
            },
          };
          touched += 1;
        }
      }
      if (touched === 0) return;
      await this.writeAtomic(stageId, {
        ...stored,
        stage: { ...stored.stage, updatedAt: Date.now() },
        outline,
      });
    });
  }

  async getScene(stageId: string, sceneId: string): Promise<TScene | null> {
    const document = await this.loadDocument(stageId);
    return document?.scenes.find((s) => s.id === sceneId) ?? null;
  }

  async deleteScene(stageId: string, sceneId: string): Promise<void> {
    await this.withDocumentLock(stageId, async () => {
      const stored = await this.readStored(stageId);
      if (stored === null) return;
      this.assertCurrentForIncrementalWrite(stageId, stored);
      const scenes = stored.scenes.filter((s) => s.id !== sceneId);
      if (scenes.length === stored.scenes.length) return;
      // A deletion is a newer revision like any putScene: advance the stage
      // clock so a stale full-document save (a tab still holding the scene)
      // trips the lost-update fence instead of resurrecting it.
      const stage = { ...stored.stage, updatedAt: Date.now() };
      await this.writeAtomic(stageId, { ...stored, stage, scenes });
    });
  }
}
