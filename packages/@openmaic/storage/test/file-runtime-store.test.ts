import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe } from 'vitest';

import type { RuntimeStore } from '../src/runtime/types.js';
import { JsonFileRuntimeStore } from '../src/server/file-runtime-store.js';
import { runRuntimeStoreContract } from './runtime-contract.js';

describe('JsonFileRuntimeStore', () => {
  let dir: string;
  let store: RuntimeStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'maic-file-runtime-'));
    store = new JsonFileRuntimeStore({ dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  runRuntimeStoreContract('Json files', () => store);
});
