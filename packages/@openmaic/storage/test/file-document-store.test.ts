import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { DocumentStore } from '../src/document/types.js';
import { DocumentLostUpdateError } from '../src/document/types.js';
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

  // A stale room-tab heartbeat used to lower `stage.updatedAt` below a
  // maintenance write's revision, disarming the saveDocument lost-update
  // fence so the tab's next full save clobbered repaired content.
  test('never lowers the stage clock on putStage', async () => {
    await store.saveDocument(makeDocument());
    const loaded = await store.loadDocument('stage-1');
    const newer = loaded!.stage.updatedAt + 10_000;
    await store.putStage('stage-1', { ...loaded!.stage, updatedAt: newer });
    await store.putStage('stage-1', { ...loaded!.stage, updatedAt: loaded!.stage.updatedAt });
    const after = await store.loadDocument('stage-1');
    expect(after!.stage.updatedAt).toBe(newer);
  });

  // Two tabs hold the same scene; one was repaired meanwhile. The stale copy
  // must not overwrite the newer one.
  test('refuses stale scene writes and accepts equal or newer ones', async () => {
    await store.saveDocument(makeDocument());
    const loaded = await store.loadDocument('stage-1');
    const scene = loaded!.scenes.find((s) => s.id === 'scene-a')!;
    const baseUpdatedAt = Number((scene as { updatedAt?: number }).updatedAt) || 0;
    const newerScene = { ...scene, updatedAt: baseUpdatedAt + 5, title: 'newer' };
    await store.putScene('stage-1', newerScene);

    await expect(
      store.putScene('stage-1', { ...scene, updatedAt: baseUpdatedAt + 1, title: 'stale' }),
    ).rejects.toBeInstanceOf(DocumentLostUpdateError);

    // Equal timestamp re-write stays legal (idempotent flush).
    await store.putScene('stage-1', newerScene);
    const after = await store.loadDocument('stage-1');
    expect(after!.scenes.find((s) => s.id === 'scene-a')!.title).toBe('newer');
  });

  // A tab that still holds a deleted scene must not resurrect it with a
  // stale full save: the deletion advances the stage clock like putScene.
  test('a stale full save cannot resurrect a deleted scene', async () => {
    const original = makeDocument();
    await store.saveDocument(original);
    const stale = await store.loadDocument('stage-1');
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.deleteScene('stage-1', 'scene-a');

    await expect(store.saveDocument(stale!)).rejects.toBeInstanceOf(DocumentLostUpdateError);
    const after = await store.loadDocument('stage-1');
    expect(after!.scenes.map((s) => s.id)).toEqual(['scene-b']);
  });
});
