import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { HttpAssetStore } from '../src/asset/http.js';
import { __setAssetIdFactoryForTesting, toAssetId } from '../src/asset/id.js';
import { AssetNotFoundError, type AssetPrincipal } from '../src/asset/types.js';
import { JsonFileAssetStore } from '../src/server/file-asset-store.js';
import { runAssetStoreContract } from './asset-contract.js';
import {
  startAssetConformanceServer,
  type AssetConformanceServer,
} from './asset-conformance-server.js';
import { blobForObjectUrl } from './setup.js';

const blob = (value: string, type = 'text/plain'): Blob => new Blob([value], { type });
const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);
const principal: AssetPrincipal = { key: 'shared' };

// The shared HTTP contract, end to end: HttpAssetStore -> the package's asset
// HTTP handler -> JsonFileAssetStore on a fresh directory per namespace.
describe('JsonFileAssetStore over HTTP', () => {
  let server: AssetConformanceServer;
  const dirs: string[] = [];
  const stores: HttpAssetStore[] = [];
  let namespace = 0;

  beforeAll(async () => {
    server = await startAssetConformanceServer({
      store: () => {
        const dir = mkdtempSync(join(tmpdir(), 'maic-file-assets-'));
        dirs.push(dir);
        return new JsonFileAssetStore({ dir });
      },
    });
  });

  afterEach(async () => {
    __setAssetIdFactoryForTesting(null);
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  afterAll(async () => {
    await server.close();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  runAssetStoreContract(
    'HttpAssetStore over JsonFileAssetStore',
    {
      makeStore: () => {
        const storeId = `file-asset-${namespace++}`;
        const store = new HttpAssetStore({
          baseUrl: server.baseUrl,
          fetch: server.fetch,
          headers: () => ({ 'x-asset-store-id': storeId, 'x-asset-principal': 'principal-a' }),
        });
        stores.push(store);
        return store;
      },
      withAllocator: async (allocator, run) => {
        __setAssetIdFactoryForTesting(allocator);
        try {
          return await run();
        } finally {
          __setAssetIdFactoryForTesting(null);
        }
      },
    },
    async (url) => {
      const stored = blobForObjectUrl(url);
      if (!stored) throw new Error('object URL is not registered');
      return new Uint8Array(await stored.arrayBuffer());
    },
  );
});

describe('JsonFileAssetStore', () => {
  let dir: string;
  let store: JsonFileAssetStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'maic-file-assets-'));
    store = new JsonFileAssetStore({ dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('stores entries in the legacy route layout', async () => {
    const id = await store.put(principal, blob('narration', 'audio/mpeg'));
    const encoded = encodeURIComponent(id);
    expect(text(await readFile(join(dir, 'assets', encoded)))).toBe('narration');
    const record = JSON.parse(
      await readFile(join(dir, 'assets', '.meta', `${encoded}.json`), 'utf8'),
    );
    expect(record).toMatchObject({ id, mime: 'audio/mpeg', size: 9, revision: 1 });
  });

  test('serves legacy refs written by the /assets/:ref route', async () => {
    await mkdir(join(dir, 'assets', '.meta'), { recursive: true });
    const withRecord = 'stage-1:img_1';
    await writeFile(join(dir, 'assets', encodeURIComponent(withRecord)), 'png bytes');
    await writeFile(
      join(dir, 'assets', '.meta', `${encodeURIComponent(withRecord)}.json`),
      JSON.stringify({ mime: 'image/png', meta: {}, size: 9 }),
    );
    const bare = 'stage-1:img_2';
    await writeFile(join(dir, 'assets', encodeURIComponent(bare)), 'raw');

    const legacy = await store.resolve(principal, withRecord);
    expect(legacy).toMatchObject({ mime: 'image/png', revision: 1 });
    expect(text(legacy?.bytes)).toBe('png bytes');
    expect(await store.identify(principal, bare)).toEqual({ mime: '', revision: 1, byteLength: 3 });
  });

  test('replace advances the revision and follows the meta contract', async () => {
    const id = await store.put(principal, blob('v1', 'image/png'), {
      contentType: 'image/png',
      prompt: 'kept',
    } as never);
    // Omitted meta: provenance retained, and an untyped blob keeps the media type.
    expect(await store.replace(principal, id, blob('v2', ''))).toBe(2);
    let record = JSON.parse(
      await readFile(join(dir, 'assets', '.meta', `${encodeURIComponent(id)}.json`), 'utf8'),
    );
    expect(record).toMatchObject({ mime: 'image/png', meta: { prompt: 'kept' }, revision: 2 });
    // Supplied meta replaces both.
    expect(await store.replace(principal, id, blob('v3', 'image/png'), { contentType: '' })).toBe(
      3,
    );
    record = JSON.parse(
      await readFile(join(dir, 'assets', '.meta', `${encodeURIComponent(id)}.json`), 'utf8'),
    );
    expect(record).toMatchObject({ mime: '', meta: { contentType: '' }, revision: 3 });
    expect(text((await store.resolve(principal, id))?.bytes)).toBe('v3');
  });

  test('another principal sees a miss, and replace rejects it as not found', async () => {
    const id = await store.put(principal, blob('mine'));
    const other: AssetPrincipal = { key: 'other' };
    expect(await store.resolve(other, id)).toBeNull();
    expect(await store.identify(other, id)).toBeNull();
    await expect(store.replace(other, id, blob('theirs'))).rejects.toBeInstanceOf(
      AssetNotFoundError,
    );
    await store.remove(other, id);
    expect(text((await store.resolve(principal, id))?.bytes)).toBe('mine');
  });

  test('an id differing only in case is a miss', async () => {
    const id = await store.put(principal, blob('exact'));
    expect(await store.resolve(principal, id.toUpperCase())).toBeNull();
  });

  test('ids that would leave the asset directory are misses', async () => {
    await store.put(principal, blob('kept'));
    for (const ref of ['..', '.', '.meta', '../documents', 'con', 'a*b']) {
      expect(await store.resolve(principal, ref)).toBeNull();
      await store.remove(principal, ref);
    }
    await expect(store.replace(principal, toAssetId('..'), blob('escape'))).rejects.toBeInstanceOf(
      AssetNotFoundError,
    );
    const listing = await readdir(join(dir, 'assets'));
    expect(listing.filter((name) => name !== '.meta')).toHaveLength(1);
  });

  test('remove deletes bytes and record', async () => {
    const id = await store.put(principal, blob('gone'));
    await store.remove(principal, id);
    expect(await store.resolve(principal, id)).toBeNull();
    expect(await readdir(join(dir, 'assets', '.meta'))).toEqual([]);
    expect((await readdir(join(dir, 'assets'))).filter((name) => name !== '.meta')).toEqual([]);
  });
});
