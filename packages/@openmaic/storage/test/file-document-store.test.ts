import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe } from 'vitest';

import type { DocumentStore } from '../src/document/types.js';
import { JsonFileDocumentStore } from '../src/server/file-document-store.js';
import { makeDocument, runDocumentStoreContract } from './document-contract.js';

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
});
