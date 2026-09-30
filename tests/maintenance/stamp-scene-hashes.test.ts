import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/utils/generation-session-store', () => ({
  loadGenerationParams: vi.fn(async () => undefined),
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn(async () => undefined),
  saveStageDataIncremental: vi.fn(async () => undefined),
  loadStageData: vi.fn(async () => null),
}));
vi.mock('@/lib/utils/database', () => ({ db: {} }));

import { stampCourseSceneHashes } from '@/lib/maintenance/stamp-scene-hashes';
import { useStageStore } from '@/lib/store/stage';
import type { SceneOutline } from '@/lib/types/generation';
import { outlineFingerprint } from '@/lib/utils/outline-fingerprint';

const outline = (id: string, description = 'desc'): SceneOutline => ({
  id,
  type: 'slide',
  title: id,
  description,
  keyPoints: ['k'],
  order: 1,
});

const scene = (id: string, outlineId?: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    stageId: 'stage',
    type: 'slide',
    title: id,
    order: 1,
    content: { type: 'slide', canvas: { elements: [] } },
    ...(outlineId ? { outlineId } : {}),
    ...extra,
  }) as never;

let counter = 0;
function open(scenes: unknown[], outlines: SceneOutline[]) {
  counter += 1;
  const stageId = `stamp-stage-${counter}`;
  useStageStore.setState({
    stage: { id: stageId, name: 'S', createdAt: 1, updatedAt: 1 } as never,
    scenes: scenes as never,
    outlines,
  });
  return stageId;
}

describe('stampCourseSceneHashes', () => {
  beforeEach(() => {
    useStageStore.getState().clearStore();
  });

  it('gives scenes that predate the stamp the current plan as their baseline', async () => {
    const o = outline('o1');
    const stageId = open([scene('s1', 'o1', { actionsSourceHash: 'x' })], [o]);

    const report = await stampCourseSceneHashes(stageId);

    expect(report?.stamped).toBe(1);
    expect(useStageStore.getState().scenes[0].outlineSourceHash).toBe(outlineFingerprint(o));
    // Baseline adopted, so a plan that has not moved queues nothing.
    expect(useStageStore.getState().reconcilePlanStaleness()).toBe(0);
  });

  it('never overwrites a plan a scene already recorded, so a later change is seen', async () => {
    const stageId = open(
      [scene('s1', 'o1', { actionsSourceHash: 'x', outlineSourceHash: 'recorded-earlier' })],
      [outline('o1', 'the plan was rewritten')],
    );

    await stampCourseSceneHashes(stageId);

    expect(useStageStore.getState().scenes[0].outlineSourceHash).toBe('recorded-earlier');
    expect(useStageStore.getState().reconcilePlanStaleness()).toBe(1);
  });

  it('leaves scenes without an outline alone and keeps concurrent store changes', async () => {
    const stageId = open(
      [
        scene('s1', undefined, { actionsSourceHash: 'x' }),
        scene('s2', 'o2', { actionsSourceHash: 'y' }),
      ],
      [outline('o2')],
    );

    await stampCourseSceneHashes(stageId);
    const [s1, s2] = useStageStore.getState().scenes;

    expect(s1.outlineSourceHash).toBeUndefined();
    expect(s2.outlineSourceHash).toBeDefined();
  });

  it('stamps a course once per session', async () => {
    const stageId = open([scene('s1', 'o1', { actionsSourceHash: 'x' })], [outline('o1')]);
    expect(await stampCourseSceneHashes(stageId)).not.toBeNull();
    expect(await stampCourseSceneHashes(stageId)).toBeNull();
  });
});
