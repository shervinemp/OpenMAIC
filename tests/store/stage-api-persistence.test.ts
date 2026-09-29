import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { incrementalSave } = vi.hoisted(() => ({
  incrementalSave: vi.fn().mockResolvedValue({ failedChanges: [] }),
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: (...args: unknown[]) => incrementalSave(...args),
  loadStageData: vi.fn().mockResolvedValue(null),
}));

import { createStageAPI } from '@/lib/api/stage-api';
import { flushStageSave, useStageStore } from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';

const stage: Stage = {
  id: 'stage-1',
  name: 'Stage',
  createdAt: 1,
  updatedAt: 1,
};

const scene: Scene = {
  id: 'scene-1',
  stageId: stage.id,
  type: 'slide',
  title: 'Scene',
  order: 1,
  content: {
    type: 'slide',
    canvas: {
      id: 'canvas-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {
        backgroundColor: '#fff',
        themeColors: ['#000'],
        fontColor: '#000',
        fontName: 'Inter',
      },
      elements: [],
    },
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  incrementalSave.mockReset().mockResolvedValue({ failedChanges: [] });
  useStageStore.getState().clearStore();
  useStageStore.setState({
    stage,
    scenes: [scene],
    currentSceneId: 'scene-1',
  });
});

afterEach(() => {
  useStageStore.getState().clearStore();
  vi.useRealTimers();
});

describe('Stage API persistence injection', () => {
  it('classifies production raw setState mutations by persisted owner', async () => {
    const api = createStageAPI(useStageStore);

    expect(
      api.element.add('scene-1', {
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        content: 'hello',
      }).success,
    ).toBe(true);
    await flushStageSave();
    expect(incrementalSave.mock.calls[0]![1]).toEqual([{ kind: 'scene', sceneId: 'scene-1' }]);

    expect(api.whiteboard.create().success).toBe(true);
    await flushStageSave();
    expect(incrementalSave.mock.calls[1]![1]).toEqual([{ kind: 'stage' }]);

    expect(api.scene.create({ type: 'slide', title: 'New scene' }).success).toBe(true);
    await flushStageSave();
    expect(incrementalSave.mock.calls[2]![1]).toEqual([{ kind: 'structure' }]);
  });

  it('creates a 16:9 landscape whiteboard (viewportRatio is height/width)', () => {
    const api = createStageAPI(useStageStore);
    const result = api.whiteboard.create();
    expect(result.success).toBe(true);
    // The 1000px-wide sheet must render 1000 x 562.5, never 1000 x 1778.
    expect(result.data?.viewportRatio).toBe(9 / 16);
    expect(result.data?.viewportRatio).toBeLessThan(1);
  });

  it('routes every raw-setState Stage API module through the guarded store', () => {
    const apiDir = path.join(process.cwd(), 'lib/api');
    const modules = [
      ['stage-api-scene.ts', 'createSceneAPI'],
      ['stage-api-element.ts', 'createElementAPI'],
      ['stage-api-canvas.ts', 'createCanvasAPI'],
      ['stage-api-mode.ts', 'createModeAPI'],
      ['stage-api-mode.ts', 'createStageMetaAPI'],
      ['stage-api-navigation.ts', 'createNavigationAPI'],
      ['stage-api-whiteboard.ts', 'createWhiteboardAPI'],
    ] as const;
    const composition = fs.readFileSync(path.join(apiDir, 'stage-api.ts'), 'utf8');

    for (const [file, factory] of modules) {
      const source = fs.readFileSync(path.join(apiDir, file), 'utf8');
      expect(source, `${file} must remain covered by this inventory`).toContain('store.setState(');
      expect(composition, `${factory} must receive the persistence wrapper`).toContain(
        `${factory}(persistenceStore)`,
      );
    }
    expect(composition).toContain('markStagePersistenceDirty(changes)');
  });
});

/**
 * The invariant: a scene object that replaces a stored one is a new revision,
 * and the server's stale-scene fence refuses any `putScene` older than the copy
 * it holds. Three live paths in the app shipped without advancing the clock and
 * the failure was silent — a 409 in a log, an autosave retry loop, and every
 * dirty scene queued behind the refused one silently unwritten. No test caught
 * any of them, so the clock is now owned by the injection boundary and this
 * asserts it for every scene-writing module.
 */
describe('Stage API revision clock', () => {
  // The suite runs on fake timers, so the clock only moves when a test moves
  // it. Park the store's scene in the past and pin "now" ahead of it.
  const NOW = 1_700_000_000_000;
  const BEFORE = NOW - 60_000;
  const parkSceneInThePast = () => {
    vi.setSystemTime(NOW);
    useStageStore.setState({ scenes: [{ ...scene, updatedAt: BEFORE }] });
    return BEFORE;
  };

  it('advances updatedAt for scenes a raw setState replaced', () => {
    const before = parkSceneInThePast();
    const api = createStageAPI(useStageStore);

    expect(
      api.element.add('scene-1', {
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        content: 'hello',
      }).success,
    ).toBe(true);

    // No call site stamps the clock any more — the boundary owns it. If this
    // regresses, the server's stale-scene fence starts refusing the scene's
    // every later write, silently.
    expect(useStageStore.getState().scenes[0]!.updatedAt).toBe(NOW);
    expect(useStageStore.getState().scenes[0]!.updatedAt).toBeGreaterThan(before);
  });

  it('re-stamps a replacement scene a caller handed over with a stale clock', () => {
    const before = parkSceneInThePast();
    const api = createStageAPI(useStageStore);

    // What a call site that forgot the convention looks like: a replacement
    // scene object still carrying the revision it was loaded at.
    useStageStore.setState({ scenes: [{ ...scene, updatedAt: before }] });
    expect(useStageStore.getState().scenes[0]!.updatedAt).toBe(before);

    expect(
      api.element.add('scene-1', {
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        content: 'stale fix',
      }).success,
    ).toBe(true);

    expect(useStageStore.getState().scenes[0]!.updatedAt).toBe(NOW);
  });

  it('leaves scenes it did not replace on their own clock', () => {
    parkSceneInThePast();
    const api = createStageAPI(useStageStore);
    useStageStore.setState({
      scenes: [
        { ...scene, id: 'scene-1' },
        { ...scene, id: 'scene-2', order: 2, updatedAt: BEFORE },
      ],
    });

    expect(api.scene.update('scene-1', { title: 'Renamed' }).success).toBe(true);

    const scenes = useStageStore.getState().scenes;
    expect(scenes.find((s) => s.id === 'scene-1')!.updatedAt).toBe(NOW);
    // Position-keyed comparison would have stamped this one too, just for
    // being array-stable behind an edit it never received.
    expect(scenes.find((s) => s.id === 'scene-2')!.updatedAt).toBe(BEFORE);
  });

  it('applies the clock to a non-production store without marking it dirty', () => {
    // The server's in-memory classroom generator runs the same modules, and the
    // persisted document outlives the request — so the clock must not be gated
    // on `store === useStageStore`, the way the dirty-marking is.
    vi.setSystemTime(NOW);
    let state = {
      stage,
      scenes: [{ ...scene, updatedAt: BEFORE }] as Scene[],
      currentSceneId: 'scene-1' as string | null,
    };
    const memoryStore = {
      getState: () => state,
      setState: (partial: Partial<typeof state>) => {
        state = { ...state, ...partial };
      },
      subscribe: () => () => undefined,
    };

    const api = createStageAPI(memoryStore as never);
    expect(
      api.element.add('scene-1', {
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        content: 'server side',
      }).success,
    ).toBe(true);

    expect(state.scenes[0]!.updatedAt).toBe(NOW);
    // Non-production: nothing scheduled a flush of the live store.
    expect(incrementalSave).not.toHaveBeenCalled();
  });
});
