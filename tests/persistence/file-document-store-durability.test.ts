import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonFileDocumentStore } from '@openmaic/storage/server/file-document-store';
import { makeDocument } from '../../packages/@openmaic/storage/test/document-contract';

describe('JsonFileDocumentStore durability', () => {
  let dir: string;
  let store: JsonFileDocumentStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'om-doc-durability-'));
    store = new JsonFileDocumentStore({ dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a gzip backup chain and recovers a zeroed document from it', async () => {
    const document = makeDocument('durable-course');
    await store.saveDocument(document as never);

    const target = join(dir, 'documents', 'durable-course.json');
    const backup = target + '.bak.gz';
    const magic = await readFile(backup);
    expect([magic[0], magic[1]]).toEqual([0x1f, 0x8b]);

    // Simulate the incident: the live aggregate is entirely zeroed.
    const size = (await readFile(target)).length;
    await writeFile(target, Buffer.alloc(size, 0));

    const recovered = await store.loadDocument('durable-course');
    expect(recovered).not.toBeNull();
    expect(recovered!.stage.id).toBe('durable-course');
    const restored = await readFile(target, 'utf8');
    expect(JSON.parse(restored).stage.id).toBe('durable-course');
  });

  it('keeps older verified generations when the newest backup is corrupt', async () => {
    const document = makeDocument('generation-course');
    await store.saveDocument(document as never);
    const target = join(dir, 'documents', 'generation-course.json');
    await store.saveDocument({ ...document, stage: { ...document.stage, updatedAt: Date.now() + 1 } } as never);

    expect((await readFile(target + '.bak.1.gz')).length).toBeGreaterThan(0);
    await writeFile(target + '.bak.gz', Buffer.alloc(32, 0));

    await writeFile(target, Buffer.alloc(64, 0));
    const recovered = await store.loadDocument('generation-course');
    expect(recovered?.stage.id).toBe('generation-course');
  });
});
