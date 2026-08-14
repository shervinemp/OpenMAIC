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
 * file. Concurrency is single-writer (one local user); no locking is needed.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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
  SceneLike,
  SceneValidator,
  StageValidator,
} from '../document/types.js';
import { DocumentNotFoundError, DocumentVersionError } from '../document/types.js';

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

function assertValid(result: ReturnType<StageValidator>, label: string): void {
  if (result.valid) return;
  const detail = result.errors.map((e) => `${e.path || '/'}: ${e.message}`).join('; ');
  throw new Error(`@openmaic/storage: invalid ${label}: ${detail}`);
}

function assertStorableScene(scene: SceneLike, stageId: string): void {
  const value = scene as { id: unknown; stageId: unknown; order: unknown };
  if (typeof value.id !== 'string') {
    throw new Error(`@openmaic/storage: scene id must be a string, got ${JSON.stringify(value.id)}`);
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
    const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
    await writeFile(tmp, JSON.stringify(document), 'utf8');
    await rename(tmp, path);
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

  async saveDocument(document: MaicDocument<TScene, TStage>): Promise<void> {
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
    await this.writeAtomic(stageId, { ...normalized, dslVersion: DSL_VERSION });
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
    await this.removeFile(stageId);
  }

  async putStage(stageId: string, stage: TStage): Promise<void> {
    assertValid(this.validateStageFn(stage), `stage ${stage.id}`);
    if (stage.id !== stageId) {
      throw new Error(
        `@openmaic/storage: stage ${JSON.stringify(stage.id)} does not belong to document ` +
          JSON.stringify(stageId),
      );
    }
    const stored = await this.readStored(stageId);
    if (stored === null) {
      throw new DocumentNotFoundError(
        stageId,
        `@openmaic/storage: cannot putStage into missing document ${JSON.stringify(stageId)}`,
      );
    }
    this.assertCurrentForIncrementalWrite(stageId, stored);
    await this.writeAtomic(stageId, {
      ...stored,
      stage: { ...stage, [DSL_VERSION_KEY]: DSL_VERSION },
    });
  }

  async putScene(stageId: string, scene: TScene): Promise<void> {
    assertValid(this.validateSceneFn(scene), `scene ${scene.id}`);
    assertStorableScene(scene, stageId);
    const stored = await this.readStored(stageId);
    if (stored === null) {
      throw new DocumentNotFoundError(
        stageId,
        `@openmaic/storage: cannot putScene into missing document ${JSON.stringify(stageId)}`,
      );
    }
    this.assertCurrentForIncrementalWrite(stageId, stored);
    const scenes = stored.scenes.map((s) => (s.id === scene.id ? scene : s));
    if (!scenes.some((s) => s.id === scene.id)) scenes.push(scene);
    await this.writeAtomic(stageId, { ...stored, scenes });
  }

  async getScene(stageId: string, sceneId: string): Promise<TScene | null> {
    const document = await this.loadDocument(stageId);
    return document?.scenes.find((s) => s.id === sceneId) ?? null;
  }

  async deleteScene(stageId: string, sceneId: string): Promise<void> {
    const stored = await this.readStored(stageId);
    if (stored === null) return;
    this.assertCurrentForIncrementalWrite(stageId, stored);
    const scenes = stored.scenes.filter((s) => s.id !== sceneId);
    await this.writeAtomic(stageId, { ...stored, scenes });
  }
}
