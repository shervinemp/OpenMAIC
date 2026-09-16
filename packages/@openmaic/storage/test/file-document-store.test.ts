import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { DocumentStore } from '../src/document/types.js';
import { JsonFileDocumentStore } from '../src/server/file-document-store.js';
import { makeDocument, runDocumentStoreContract, slideScene } from './document-contract.js';

describe('JsonFileDocumentStore', () => {
  let dir: string;
  let store: DocumentStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'maic-file-docs-'));
    store = new JsonFileDocumentStore({ dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  runDocumentStoreContract('Json files', () => ({
    store,
    async seedStoredVersion(stageId, version) {
      const docs = join(dir, 'documents');
      await mkdir(docs, { recursive: true });
      const raw = { ...makeDocument(stageId), dslVersion: version };
      await writeFile(
        join(docs, `${encodeURIComponent(stageId)}.json`),
        JSON.stringify(raw),
        'utf8',
      );
    },
  }));

  // Incremental writes are read-modify-write; without the per-document write
  // mutex, concurrent requests interleave (each reads the same base) and all
  // but the last scene vanish — the lost-update class the classroom's two-tab
  // loads produced.
  test('serializes concurrent incremental writes to one document', async () => {
    await store.saveDocument(makeDocument());
    const extraIds = Array.from({ length: 8 }, (_, i) => `scene-c${i}`);
    await Promise.all(
      extraIds.map((id, i) => store.putScene('stage-1', slideScene('stage-1', id, 10 + i))),
    );

    const loaded = await store.loadDocument('stage-1');
    expect(loaded?.scenes.map((s) => s.id).sort()).toEqual(
      ['scene-a', 'scene-b', ...extraIds].sort(),
    );
  });
});
