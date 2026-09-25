/**
 * JsonFileAssetStore — the single-user, zero-dependency `AssetStore` behind a
 * file-backed (PERSISTENCE_DIR) deployment, so the allocated-id asset pool
 * (`POST /assets`, `/assets/:id/content`) works without PostgreSQL.
 *
 * Layout: `<dir>/assets/<encodeURIComponent(id)>` holds an entry's bytes and
 * `<dir>/assets/.meta/<encodeURIComponent(id)>.json` its record
 * (`{ id, principal, mime, meta, size, revision }`). That is the layout the
 * app's legacy `/assets/:ref` route and the course git snapshot already read
 * and write, so an allocated id is served, snapshotted, and restored exactly
 * like a legacy ref. A legacy record (`{ mime, meta, size }`, or bytes with no
 * record at all) reads as revision 1 with no principal restriction.
 *
 * Deliberate differences from the registry backends, all sized for one user
 * on one disk:
 * - No content-addressed deduplication: every entry owns its own bytes file,
 *   so `remove` deletes the bytes directly (no other entry can name them) and
 *   there is no offline collector to schedule.
 * - No pending TTL: an allocation no document ever names is kept, not
 *   expired. The disk is the user's, and a lost allocation is the costlier
 *   failure for a local course.
 * - No quota.
 *
 * Concurrency: every operation on one id runs under an in-process per-id
 * lock, so a `resolve` never pairs one revision's record with another
 * revision's bytes; bytes and records are written through a temp file and an
 * atomic rename, bytes first, so a crash never leaves a record naming bytes
 * that were not stored.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AssetMeta, AssetRef, BinaryBlob } from '@openmaic/dsl';

import { newAssetId, type AssetId } from '../asset/id.js';
import {
  AssetNotFoundError,
  type AssetBytes,
  type AssetIdentity,
  type AssetPrincipal,
  type AssetStore,
} from '../asset/types.js';

export interface JsonFileAssetStoreOptions {
  /** Root directory; the `assets/` subdirectory is created on demand. */
  dir: string;
}

interface EntryRecord {
  /** Exact id, so a case-insensitive filesystem cannot alias two ids. */
  id?: string;
  principal?: string;
  mime?: string;
  meta?: AssetMeta;
  size?: number | null;
  revision?: number;
}

interface StoredEntry {
  record: EntryRecord;
  revision: number;
}

/**
 * Per-id operation mutex, module-scoped so it spans every store instance the
 * route constructs over the same directory.
 */
const entryLocks = new Map<string, Promise<unknown>>();

function withEntryLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = entryLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  entryLocks.set(key, tail);
  void tail.then(() => {
    if (entryLocks.get(key) === tail) entryLocks.delete(key);
  });
  return run;
}

/**
 * The on-disk name for an id: the legacy route's `encodeURIComponent`, limited
 * to names every filesystem stores verbatim. Anything else (dot segments, the
 * `.meta` directory, Windows device names, over-long ids, unencodable lone
 * surrogates) can never have been allocated here, so it is a miss.
 */
function entryFileName(ref: string): string | null {
  let encoded: string;
  try {
    encoded = encodeURIComponent(ref);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9%_\-.!~'()]{1,200}$/.test(encoded)) return null;
  if (encoded.startsWith('.') || encoded.endsWith('.')) return null;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(encoded)) return null;
  return encoded;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR';
}

export class JsonFileAssetStore implements AssetStore {
  private readonly root: string;

  constructor(options: JsonFileAssetStoreOptions) {
    this.root = options.dir;
  }

  private assetDir(): string {
    return join(this.root, 'assets');
  }

  private metaDir(): string {
    return join(this.assetDir(), '.meta');
  }

  private bytesPath(name: string): string {
    return join(this.assetDir(), name);
  }

  private recordPath(name: string): string {
    return join(this.metaDir(), `${name}.json`);
  }

  private lockKey(name: string): string {
    return `${this.root}\u0000${name.toLowerCase()}`;
  }

  /**
   * The entry stored under `ref` for this principal, or `null`. Bytes with no
   * record are a legacy entry; a record with no bytes is a miss.
   */
  private async readEntry(
    principal: AssetPrincipal,
    ref: AssetRef,
    name: string,
  ): Promise<StoredEntry | null> {
    let record: EntryRecord;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.recordPath(name), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      record = parsed as EntryRecord;
    } catch (error) {
      if (!isMissing(error)) return null;
      const bytes = await stat(this.bytesPath(name)).catch(() => null);
      if (!bytes?.isFile()) return null;
      record = {};
    }
    if (record.id !== undefined && record.id !== ref) return null;
    if (record.principal !== undefined && record.principal !== principal.key) return null;
    const revision =
      typeof record.revision === 'number' && Number.isSafeInteger(record.revision)
        ? record.revision
        : 1;
    return { record, revision };
  }

  private async writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
      try {
        await writeFile(tmp, data);
        await rename(tmp, path);
        return;
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined);
        const code = (error as NodeJS.ErrnoException).code ?? '';
        // Windows refuses a rename while another reader holds the target:
        // transient, so back off briefly before surfacing it.
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

  private async writeEntry(name: string, bytes: Uint8Array, record: EntryRecord): Promise<void> {
    await mkdir(this.metaDir(), { recursive: true });
    await this.writeAtomic(this.bytesPath(name), bytes);
    await this.writeAtomic(this.recordPath(name), JSON.stringify(record));
  }

  async put(principal: AssetPrincipal, data: BinaryBlob, meta?: AssetMeta): Promise<AssetId> {
    const storedMeta = meta ?? {};
    const bytes = new Uint8Array(await data.arrayBuffer());
    const id = newAssetId();
    const name = entryFileName(id);
    if (name === null) throw new Error('@openmaic/storage: allocated asset id is not storable');
    await withEntryLock(this.lockKey(name), () =>
      this.writeEntry(name, bytes, {
        id,
        principal: principal.key,
        mime: storedMeta.contentType ?? data.type,
        meta: storedMeta,
        size: bytes.byteLength,
        revision: 1,
      }),
    );
    return id;
  }

  async identify(principal: AssetPrincipal, ref: AssetRef): Promise<AssetIdentity | null> {
    const name = entryFileName(ref);
    if (name === null) return null;
    return withEntryLock(this.lockKey(name), async () => {
      const entry = await this.readEntry(principal, ref, name);
      if (entry === null) return null;
      const bytes = await stat(this.bytesPath(name)).catch(() => null);
      if (!bytes?.isFile()) return null;
      return { mime: entry.record.mime ?? '', revision: entry.revision, byteLength: bytes.size };
    });
  }

  async resolve(principal: AssetPrincipal, ref: AssetRef): Promise<AssetBytes | null> {
    const name = entryFileName(ref);
    if (name === null) return null;
    return withEntryLock(this.lockKey(name), async () => {
      const entry = await this.readEntry(principal, ref, name);
      if (entry === null) return null;
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(this.bytesPath(name)));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      return { bytes, mime: entry.record.mime ?? '', revision: entry.revision };
    });
  }

  async remove(principal: AssetPrincipal, ref: AssetRef): Promise<void> {
    const name = entryFileName(ref);
    if (name === null) return;
    await withEntryLock(this.lockKey(name), async () => {
      if ((await this.readEntry(principal, ref, name)) === null) return;
      // Record first: an interrupted remove leaves orphan bytes (served as a
      // legacy entry), never a record that names nothing.
      await rm(this.recordPath(name), { force: true });
      await rm(this.bytesPath(name), { force: true });
    });
  }

  async replace(
    principal: AssetPrincipal,
    ref: AssetId,
    data: BinaryBlob,
    meta?: AssetMeta,
  ): Promise<number> {
    const name = entryFileName(ref);
    if (name === null) throw new AssetNotFoundError();
    const bytes = new Uint8Array(await data.arrayBuffer());
    return withEntryLock(this.lockKey(name), async () => {
      const entry = await this.readEntry(principal, ref, name);
      if (entry === null) throw new AssetNotFoundError();
      const revision = entry.revision + 1;
      // Omitted meta retains the recorded provenance and media type (unless
      // the blob carries one); supplied meta replaces both.
      const next: EntryRecord =
        meta === undefined
          ? {
              ...entry.record,
              mime: data.type === '' ? (entry.record.mime ?? '') : data.type,
            }
          : { ...entry.record, mime: meta.contentType ?? data.type, meta };
      await this.writeEntry(name, bytes, {
        ...next,
        id: ref,
        principal: entry.record.principal ?? principal.key,
        size: bytes.byteLength,
        revision,
      });
      return revision;
    });
  }
}
