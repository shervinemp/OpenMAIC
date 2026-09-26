import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonFileDocumentStore } from '@openmaic/storage/server/file-document-store';
import { makeDocument } from '../../packages/@openmaic/storage/test/document-contract';

/**
 * File-backed persistence is single-user, so the owner sidecar must name the
 * local user the owner of every stored course. It answered 404 (the database
 * path's "no such course"), which closed the classroom's owner gate on every
 * course: no resume, no Retry, no repair on a PERSISTENCE_DIR install.
 */
describe('stage meta on file-backed persistence', () => {
  let dir: string;

  const get = async (stageId: string) => {
    const { GET } = await import('@/app/api/stage-meta/[stageId]/route');
    return GET(new NextRequest(`http://localhost/api/stage-meta/${stageId}`), {
      params: Promise.resolve({ stageId }),
    });
  };

  beforeEach(async () => {
    vi.resetModules();
    dir = await mkdtemp(join(tmpdir(), 'om-stage-meta-'));
    vi.stubEnv('PERSISTENCE_DIR', dir);
    vi.stubEnv('DATABASE_URL', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('names the local user the owner of a stored course', async () => {
    const document = makeDocument('stage-file');
    await new JsonFileDocumentStore({ dir }).saveDocument({
      ...document,
      outline: { ...(document.outline ?? {}), generationComplete: true },
    } as never);

    const response = await get('stage-file');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      isOwner: true,
      isPublic: false,
      generationComplete: true,
      source: 'file',
    });
  });

  it('answers 404 for a course the store does not hold', async () => {
    const response = await get('missing-stage');

    expect(response.status).toBe(404);
  });
});
