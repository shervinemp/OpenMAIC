import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonFileAssetStore } from '@openmaic/storage/server/file-asset-store';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { storeGeneratedAsset } from '@/lib/server/store-generated-asset';

describe('storeGeneratedAsset on file-backed installs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openmaic-generated-asset-'));
    vi.stubEnv('PERSISTENCE_DIR', dir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('allocates in the file-backed pool without a PostgreSQL connection', async () => {
    const stored = await storeGeneratedAsset({
      ownerId: 'local',
      stageId: 'course-1',
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'image/png',
      kind: 'image',
    });

    expect(stored.status).toBe('stored');
    if (stored.status !== 'stored') return;

    const store = new JsonFileAssetStore({ dir });
    const resolved = await store.resolve(assetPrincipalForOwner('local'), stored.assetId);
    expect(resolved).not.toBeNull();
    expect(new Uint8Array(resolved!.bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
