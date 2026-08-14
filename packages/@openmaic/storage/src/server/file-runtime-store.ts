/**
 * JsonFileRuntimeStore — a zero-dependency, single-user `RuntimeStore`
 * backend persisting one JSON file per runtime session on local disk.
 *
 * Layout: `<dir>/runtime/<encoded-sessionId>.json` holding
 * `{ session: RuntimeSession, records: RuntimeRecord[] }` — records stay
 * ordered by `seq` (their array index), the exact replay ordering key.
 *
 * Semantics mirror `PgRuntimeStore` (the contract reference):
 * - Sessions are born stamped with `RUNTIME_DSL_VERSION`; the store owns the
 *   stamp, never the caller.
 * - Reads migrate on read and validate the envelope; listings omit corrupt
 *   rows while direct reads stay fail-loud.
 * - Write paths reject future-stamped sessions (never downgrade a newer
 *   client's data), migrate older-stamped sessions in place first, and
 *   validate the completed envelope before persisting.
 * - `appendRecord` / `setSessionStatus` honor the `expectedLastSeq`
 *   compare-and-swap via {@link RuntimeAppendConflictError}.
 * - `mergeLearner` re-keys across all stages atomically (all temp files are
 *   written before any rename commits, so a failure applies none of them —
 *   the file-store analogue of a transaction; only an OS-level crash between
 *   renames can leave a partial merge, which a rerun completes idempotently).
 *
 * Durability: every write is a temp file + atomic rename. Single-user
 * concurrency assumption: the app serializes writes per session, matching the
 * lock the pg backend takes per row.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  RUNTIME_DSL_VERSION,
  migrateRuntime,
  needsRuntimeMigration,
  runtimeDslVersionOf,
  validateRuntimeRecord,
  validateRuntimeSession,
} from '@openmaic/dsl';
import type {
  RuntimePayload,
  RuntimeRecord,
  RuntimeRecordInit,
  RuntimeSession,
  RuntimeSessionStatus,
} from '@openmaic/dsl';

import type {
  RuntimeAppendOptions,
  RuntimePayloadValidator,
  RuntimeSessionInit,
  RuntimeStore,
  RuntimeTailOptions,
} from '../runtime/types.js';
import { RuntimeAppendConflictError } from '../runtime/types.js';

export interface JsonFileRuntimeStoreOptions {
  /** Root directory; the `runtime/` subdirectory is created on demand. */
  dir: string;
  /** Per-kind record payload validators. Defaults to the chat/quizAttempt guards. */
  payloadValidators?: Record<string, RuntimePayloadValidator>;
}

const DEFAULT_PAYLOAD_VALIDATORS: Record<string, RuntimePayloadValidator> = {
  chat: (payload) =>
    isRuntimePayloadObject(payload) && typeof payload.role === 'string' && 'content' in payload
      ? { valid: true }
      : {
          valid: false,
          errors: [
            {
              path: '/payload',
              message: 'chat payload must match ChatMessageSkeleton (role + content)',
            },
          ],
        },
  quizAttempt: (payload) =>
    isRuntimePayloadObject(payload) &&
    typeof payload.phase === 'string' &&
    'answers' in payload
      ? { valid: true }
      : {
          valid: false,
          errors: [
            {
              path: '/payload',
              message: 'quizAttempt payload must match QuizAttemptSkeleton (phase + answers)',
            },
          ],
        },
};

function isRuntimePayloadObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertValid(result: ReturnType<typeof validateRuntimeSession>, label: string): void {
  if (result.valid) return;
  const detail = result.errors.map((e) => `${e.path || '/'}: ${e.message}`).join('; ');
  throw new Error(`@openmaic/storage: invalid ${label}: ${detail}`);
}

function isFutureRuntimeVersioned(row: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  return !needsRuntimeMigration(row) && runtimeDslVersionOf(row) !== RUNTIME_DSL_VERSION;
}

function futureSessionError(sessionId: string, row: RuntimeSession): Error {
  return new Error(
    `@openmaic/storage: session ${JSON.stringify(sessionId)} was written at runtime DSL ` +
      `version ${JSON.stringify(runtimeDslVersionOf(row))}, newer than this client's ` +
      `${RUNTIME_DSL_VERSION}`,
  );
}

function migrateSession(row: RuntimeSession): RuntimeSession {
  return needsRuntimeMigration(row) ? (migrateRuntime(row) as RuntimeSession) : row;
}

function encodeJson(value: unknown, label: string): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('value is not JSON-serializable');
    return encoded;
  } catch (error) {
    throw new Error(`@openmaic/storage: ${label} is not JSON-serializable`, { cause: error });
  }
}

interface StoredSessionFile {
  session: RuntimeSession;
  records: RuntimeRecord[];
}

function assertExpectedLastSeq(expectedLastSeq: number | null | undefined): void {
  if (
    expectedLastSeq !== undefined &&
    expectedLastSeq !== null &&
    (!Number.isSafeInteger(expectedLastSeq) || expectedLastSeq < 0)
  ) {
    throw new Error('@openmaic/storage: expectedLastSeq must be null or a non-negative integer');
  }
}

export class JsonFileRuntimeStore implements RuntimeStore {
  private readonly root: string;
  private readonly payloadValidators: Record<string, RuntimePayloadValidator>;

  constructor(options: JsonFileRuntimeStoreOptions) {
    this.root = options.dir;
    this.payloadValidators = options.payloadValidators ?? DEFAULT_PAYLOAD_VALIDATORS;
  }

  private runtimeDir(): string {
    return join(this.root, 'runtime');
  }

  private sessionPath(sessionId: string): string {
    return join(this.runtimeDir(), `${encodeURIComponent(sessionId)}.json`);
  }

  private async readStored(sessionId: string): Promise<StoredSessionFile | null> {
    try {
      const raw = await readFile(this.sessionPath(sessionId), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error(
          `@openmaic/storage: corrupt stored row for session ${JSON.stringify(sessionId)}: ` +
            'data must be a plain object',
        );
      }
      return parsed as StoredSessionFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async writeAtomic(sessionId: string, stored: StoredSessionFile): Promise<void> {
    await mkdir(this.runtimeDir(), { recursive: true });
    const path = this.sessionPath(sessionId);
    const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
    await writeFile(tmp, encodeJson(stored, `runtime session ${JSON.stringify(sessionId)}`), 'utf8');
    await rename(tmp, path);
  }

  private async removeFile(sessionId: string): Promise<void> {
    try {
      await rm(this.sessionPath(sessionId), { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async listAllStored(): Promise<StoredSessionFile[]> {
    let files: string[];
    try {
      files = await readdir(this.runtimeDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const stored: StoredSessionFile[] = [];
    for (const file of files) {
      if (!file.endsWith('.json') || file.includes('.tmp-')) continue;
      try {
        const raw = await readFile(join(this.runtimeDir(), file), 'utf8');
        stored.push(JSON.parse(raw) as StoredSessionFile);
      } catch {
        // Listings omit corrupt rows; direct reads remain fail-loud.
      }
    }
    return stored;
  }

  private validatorFor(kind: string): RuntimePayloadValidator | undefined {
    return Object.hasOwn(this.payloadValidators, kind) ? this.payloadValidators[kind] : undefined;
  }

  async createSession(init: RuntimeSessionInit): Promise<RuntimeSession> {
    const stamped: RuntimeSession = { ...init, runtimeDslVersion: RUNTIME_DSL_VERSION };
    assertValid(validateRuntimeSession(stamped), `runtime session ${JSON.stringify(stamped.id)}`);
    const existing = await this.readStored(stamped.id);
    if (existing !== null) {
      throw new Error(`@openmaic/storage: session ${JSON.stringify(stamped.id)} already exists`);
    }
    await this.writeAtomic(stamped.id, { session: stamped, records: [] });
    return stamped;
  }

  async getSession(sessionId: string): Promise<RuntimeSession | undefined> {
    const stored = await this.readStored(sessionId);
    if (stored === null) return undefined;
    const session = migrateSession(stored.session);
    assertValid(validateRuntimeSession(session), `stored runtime session ${JSON.stringify(sessionId)}`);
    return session;
  }

  async listSessions(stageId: string, learnerKey: string): Promise<RuntimeSession[]> {
    const sessions: RuntimeSession[] = [];
    for (const stored of await this.listAllStored()) {
      const session = stored.session;
      if (session.stageId !== stageId || session.learnerKey !== learnerKey) continue;
      try {
        const migrated = migrateSession(session);
        assertValid(
          validateRuntimeSession(migrated),
          `stored runtime session ${JSON.stringify(session.id)}`,
        );
        sessions.push(migrated);
      } catch {
        // Listings omit corrupt rows; direct reads remain fail-loud.
      }
    }
    return sessions.sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  async setSessionStatus(
    sessionId: string,
    status: RuntimeSessionStatus,
    updatedAt: string,
    options: RuntimeTailOptions = {},
  ): Promise<void> {
    assertExpectedLastSeq(options.expectedLastSeq);
    const stored = await this.readStored(sessionId);
    if (stored === null) throw new Error(`@openmaic/storage: no session ${JSON.stringify(sessionId)}`);
    if (isFutureRuntimeVersioned(stored.session)) throw futureSessionError(sessionId, stored.session);
    const updated: RuntimeSession = { ...migrateSession(stored.session), status, updatedAt };
    assertValid(validateRuntimeSession(updated), `runtime session ${JSON.stringify(sessionId)}`);
    if (options.expectedLastSeq !== undefined) {
      const actualLastSeq = stored.records.length === 0 ? null : stored.records.length - 1;
      if (options.expectedLastSeq !== actualLastSeq) {
        throw new RuntimeAppendConflictError(sessionId, options.expectedLastSeq, actualLastSeq);
      }
    }
    await this.writeAtomic(sessionId, { ...stored, session: updated });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.removeFile(sessionId);
  }

  async appendRecord<TPayload extends RuntimePayload>(
    init: RuntimeRecordInit<TPayload>,
    options: RuntimeAppendOptions = {},
  ): Promise<RuntimeRecord<TPayload>> {
    assertValid(validateRuntimeRecord({ ...init, seq: 0 }), `runtime record ${JSON.stringify(init.id)}`);
    assertExpectedLastSeq(options.expectedLastSeq);
    const stored = await this.readStored(init.sessionId);
    if (stored === null) {
      throw new Error(`@openmaic/storage: no session ${JSON.stringify(init.sessionId)}`);
    }
    if (isFutureRuntimeVersioned(stored.session)) {
      throw futureSessionError(init.sessionId, stored.session);
    }
    let session = stored.session;
    if (needsRuntimeMigration(session)) session = migrateSession(session);
    if (session.status !== 'active') {
      throw new Error(
        `@openmaic/storage: cannot append to session ${JSON.stringify(init.sessionId)} with ` +
          `status '${session.status}' — records may only be appended to an active session`,
      );
    }
    const validator = this.validatorFor(session.kind);
    if (validator) {
      assertValid(validator(init.payload), `runtime record ${JSON.stringify(init.id)}`);
    }
    const actualLastSeq = stored.records.length === 0 ? null : stored.records.length - 1;
    if (options.expectedLastSeq !== undefined && options.expectedLastSeq !== actualLastSeq) {
      throw new RuntimeAppendConflictError(init.sessionId, options.expectedLastSeq, actualLastSeq);
    }
    const seq = stored.records.length;
    const record: RuntimeRecord<TPayload> = { ...init, seq };
    assertValid(validateRuntimeRecord(record), `runtime record ${JSON.stringify(init.id)}`);
    const transition = options.sessionTransition;
    const updatedSession: RuntimeSession | undefined = transition
      ? { ...session, status: transition.status, updatedAt: transition.updatedAt }
      : undefined;
    if (updatedSession) {
      assertValid(
        validateRuntimeSession(updatedSession),
        `runtime session ${JSON.stringify(init.sessionId)}`,
      );
    }
    const jsonRecord = { ...record } as Record<string, unknown>;
    for (const key of ['sceneId', 'actionIndex', 'subAnchor']) {
      if (jsonRecord[key] === undefined) delete jsonRecord[key];
    }
    encodeJson(jsonRecord, `runtime record ${JSON.stringify(record.id)}`);
    await this.writeAtomic(init.sessionId, {
      session: updatedSession ?? session,
      records: [...stored.records, record],
    });
    return record;
  }

  async listRecords(sessionId: string, opts?: { sceneId?: string }): Promise<RuntimeRecord[]> {
    const stored = await this.readStored(sessionId);
    if (stored === null) return [];
    return opts?.sceneId === undefined
      ? stored.records
      : stored.records.filter((record) => record.sceneId === opts.sceneId);
  }

  async mergeLearner(fromLearnerKey: string, toLearnerKey: string): Promise<number> {
    if (
      typeof fromLearnerKey !== 'string' ||
      fromLearnerKey === '' ||
      typeof toLearnerKey !== 'string' ||
      toLearnerKey === ''
    ) {
      throw new Error('@openmaic/storage: learner keys must be non-empty strings');
    }
    if (fromLearnerKey === toLearnerKey) return 0;

    const all = await this.listAllStored();
    const moved: Array<{ sessionId: string; stored: StoredSessionFile; updated: RuntimeSession }> =
      [];
    for (const stored of all) {
      if (stored.session.learnerKey !== fromLearnerKey) continue;
      if (isFutureRuntimeVersioned(stored.session)) {
        throw futureSessionError(stored.session.id, stored.session);
      }
      const updated: RuntimeSession = {
        ...migrateSession(stored.session),
        learnerKey: toLearnerKey,
      };
      assertValid(
        validateRuntimeSession(updated),
        `runtime session ${JSON.stringify(updated.id)}`,
      );
      moved.push({ sessionId: stored.session.id, stored, updated });
    }
    if (moved.length === 0) return 0;

    // Two-phase commit: write every temp file before renaming any, so a
    // failure during the write phase applies nothing.
    await mkdir(this.runtimeDir(), { recursive: true });
    const staged = await Promise.all(
      moved.map(async ({ sessionId, stored, updated }) => {
        const path = this.sessionPath(sessionId);
        const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
        await writeFile(
          tmp,
          encodeJson({ ...stored, session: updated }, `runtime session ${JSON.stringify(sessionId)}`),
          'utf8',
        );
        return { path, tmp };
      }),
    );
    await Promise.all(staged.map(({ tmp, path }) => rename(tmp, path)));
    return moved.length;
  }

  async deleteLearnerRuntime(stageId: string, learnerKey: string): Promise<void> {
    for (const stored of await this.listAllStored()) {
      if (stored.session.stageId === stageId && stored.session.learnerKey === learnerKey) {
        await this.removeFile(stored.session.id);
      }
    }
  }

  async deleteStageRuntime(stageId: string): Promise<void> {
    for (const stored of await this.listAllStored()) {
      if (stored.session.stageId === stageId) await this.removeFile(stored.session.id);
    }
  }

  async deleteAllRuntime(): Promise<void> {
    for (const stored of await this.listAllStored()) {
      await this.removeFile(stored.session.id);
    }
  }
}
