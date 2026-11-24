import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir: string;
let store: typeof import('@/lib/server/scene-draft-store');
let model: typeof import('@/lib/utils/scene-draft-model');

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'scene-drafts-'));
  process.env.SCENE_DRAFTS_DIR = dir;
  store = await import('@/lib/server/scene-draft-store');
  model = await import('@/lib/utils/scene-draft-model');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.SCENE_DRAFTS_DIR;
});

describe('server scene draft store', () => {
  it('saves and loads a raw payload', async () => {
    await store.saveSceneDraft('stage-1', 'o1', { sourceKey: 'k', content: { raw: true } });
    const drafts = await store.loadSceneDrafts('stage-1');
    expect(drafts.get('o1')).toMatchObject({
      id: 'stage-1::o1',
      sourceKey: 'k',
      content: { raw: true },
    });
  });

  it('merges actions into content under the same source key', async () => {
    await store.saveSceneDraft('stage-2', 'o1', { sourceKey: 'k', content: { c: 1 } });
    await store.saveSceneDraft('stage-2', 'o1', { sourceKey: 'k', actions: { a: 1 } });
    const draft = (await store.loadSceneDrafts('stage-2')).get('o1');
    expect(draft).toMatchObject({ content: { c: 1 }, actions: { a: 1 } });
  });

  it('evacuates drafts beyond the per-stage cap', async () => {
    for (let i = 0; i < 30; i += 1) {
      await store.saveSceneDraft('stage-3', `o${i}`, { sourceKey: 'k', content: { i } });
    }
    expect((await store.loadSceneDrafts('stage-3')).size).toBe(model.MAX_DRAFTS_PER_STAGE);
  });

  it('sweeps stale drafts and can delete one or clear a stage', async () => {
    const file = path.join(dir, 'stage-4.json');
    await writeFile(
      file,
      JSON.stringify([
        {
          id: 'stage-4::old',
          stageId: 'stage-4',
          outlineId: 'old',
          sourceKey: 'k',
          content: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    );
    await store.sweepStaleSceneDrafts();
    expect((await store.loadSceneDrafts('stage-4')).size).toBe(0);

    await store.saveSceneDraft('stage-5', 'o1', { sourceKey: 'k', content: {} });
    await store.deleteSceneDraft('stage-5', 'o1');
    expect((await store.loadSceneDrafts('stage-5')).size).toBe(0);

    await store.saveSceneDraft('stage-5', 'o2', { sourceKey: 'k', content: {} });
    await store.clearSceneDraftsForStage('stage-5');
    expect((await store.loadSceneDrafts('stage-5')).size).toBe(0);
    expect(await readFile(file, 'utf-8').catch(() => null)).toBeNull();
  });
});
