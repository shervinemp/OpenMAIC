import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The storage package's canonical valid-aggregate fixture: the file-backed
// route must accept exactly what the DSL contract considers a document.
import { makeDocument } from '../../packages/@openmaic/storage/test/document-contract';

const TOKEN = 'file-mode-test-token';

/**
 * Tests for OUR local-only branch of the persistence route:
 * PERSISTENCE_DIR selects zero-dependency JSON-file stores plus the
 * file-backed /assets endpoints — no DATABASE_URL, no Postgres.
 */
describe('embedded persistence route: file-backed mode', () => {
  let dir: string;

  const makeRoute = async () => {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    return (request: Request) => handlePersistenceRequest(request);
  };

  const authorized = (path: string, init: RequestInit = {}): Request =>
    new Request(`http://localhost/api/persistence${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    });

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    dir = await mkdtemp(join(tmpdir(), 'om-file-persistence-'));
    vi.stubEnv('PERSISTENCE_DIR', dir);
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', TOKEN);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a full document aggregate through the real JSON-file stores', async () => {
    const handle = await makeRoute();
    const doc = makeDocument('stage-file-1');

    const put = await handle(
      authorized('/documents/stage-file-1', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(doc),
      }),
    );
    expect(put.status).toBe(204);

    // One portable JSON file per lesson on disk — the entire point of the mode.
    const files = await readdir(join(dir, 'documents'));
    expect(files).toEqual(['stage-file-1.json']);
    await expect(readFile(join(dir, 'documents', 'stage-file-1.json'), 'utf8')).resolves.toContain(
      '"Intro Course"',
    );

    const get = await handle(authorized('/documents/stage-file-1'));
    expect(get.status).toBe(200);
    const loaded = (await get.json()) as typeof doc;
    // Compare like the storage package's own document-contract harness: the
    // store normalizes/migrates on read, so assert the meaningful aggregate.
    expect(loaded.stage).toMatchObject(doc.stage);
    expect(loaded.scenes.map((scene) => scene.id)).toEqual(doc.scenes.map((scene) => scene.id));
    expect(loaded.outline).toEqual(doc.outline);

    const del = await handle(authorized('/documents/stage-file-1', { method: 'DELETE' }));
    expect(del.status).toBe(204);
    const afterDelete = await handle(authorized('/documents/stage-file-1'));
    expect(afterDelete.status).toBe(404);
  });

  it('rejects an invalid aggregate at the write boundary', async () => {
    const handle = await makeRoute();

    const put = await handle(
      authorized('/documents/stage-bad', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: { id: 'stage-bad' }, scenes: [] }),
      }),
    );
    expect(put.status).toBe(400);
    // Nothing may be written for a rejected write: not even the directory.
    await expect(readdir(join(dir, 'documents'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires the development token on every request', async () => {
    const handle = await makeRoute();
    await handle(
      authorized('/documents/stage-auth', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(makeDocument('stage-auth')),
      }),
    );

    const unauthenticated = await handle(
      new Request('http://localhost/api/persistence/documents/stage-auth'),
    );
    expect(unauthenticated.status).toBe(401);

    const wrongToken = await handle(
      new Request('http://localhost/api/persistence/documents/stage-auth', {
        headers: { authorization: 'Bearer not-the-token' },
      }),
    );
    expect(wrongToken.status).toBe(401);
  });

  it('refuses to start in file mode without a configured token', async () => {
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', '');
    const handle = await makeRoute();

    const response = await handle(authorized('/documents/stage-x'));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PERSISTENCE_DEV_TOKEN_MISSING' },
    });
  });

  describe('assets endpoints', () => {
    const metaHeader = (meta: unknown): string =>
      Buffer.from(JSON.stringify(meta), 'utf8').toString('base64');

    it('stores and serves raw bytes with their recorded content type', async () => {
      const handle = await makeRoute();
      // Not valid UTF-8 as a string: proves byte-for-byte storage.
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);

      const put = await handle(
        authorized('/assets/audio-abc123', {
          method: 'PUT',
          headers: {
            'content-type': 'audio/mpeg',
            'x-asset-meta': metaHeader({ voice: 'kore', duration: 1.5 }),
          },
          body: png,
        }),
      );
      expect(put.status).toBe(204);

      const get = await handle(authorized('/assets/audio-abc123'));
      expect(get.status).toBe(200);
      expect(get.headers.get('content-type')).toBe('audio/mpeg');
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(png);

      // Metadata lands beside the bytes so later passes can inspect provenance.
      const storedMeta = JSON.parse(
        await readFile(join(dir, 'assets', '.meta', 'audio-abc123.json'), 'utf8'),
      ) as { meta: Record<string, unknown> };
      expect(storedMeta.meta).toMatchObject({ voice: 'kore' });

      const del = await handle(authorized('/assets/audio-abc123', { method: 'DELETE' }));
      expect(del.status).toBe(204);
      await expect(handle(authorized('/assets/audio-abc123'))).resolves.toMatchObject({
        status: 404,
      });
    });

    it('answers 404 for a missing ref and rejects path traversal', async () => {
      const handle = await makeRoute();

      const missing = await handle(authorized('/assets/nope'));
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toMatchObject({ error: { code: 'ASSET_NOT_FOUND' } });

      const traversal = await handle(authorized('/assets/..%2F..%2Fetc%2Fpasswd'));
      expect(traversal.status).toBe(404);
      await expect(traversal.json()).resolves.toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });
    });

    it('rejects malformed x-asset-meta with INVALID_META', async () => {
      const handle = await makeRoute();

      const bad = await handle(
        authorized('/assets/ref-1', {
          method: 'PUT',
          headers: { 'x-asset-meta': 'not-base64-json!!' },
          body: 'bytes',
        }),
      );
      expect(bad.status).toBe(400);
      await expect(bad.json()).resolves.toMatchObject({ error: { code: 'INVALID_META' } });
    });

    it('demands authentication before touching asset bytes', async () => {
      const handle = await makeRoute();

      const response = await handle(
        new Request('http://localhost/api/persistence/assets/some-ref'),
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'UNAUTHENTICATED' },
      });
    });
  });
});
