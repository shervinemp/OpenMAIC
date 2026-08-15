import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// IndexedDB / stage-storage modules are imported dynamically inside the
// store's save/load actions. Mock them so we can drive load inputs and
// observe persistence without a real IndexedDB (same seam as
// stage-generation-complete.test.ts).
const {
  hydratePBLScenesFromRuntimeMock,
  loadStageDataMock,
  saveStageDataMock,
  stageOutlinesGet,
  stageOutlinesPut,
} = vi.hoisted(() => ({
  hydratePBLScenesFromRuntimeMock: vi.fn(),
  loadStageDataMock: vi.fn(),
  saveStageDataMock: vi.fn().mockResolvedValue(undefined),
  stageOutlinesGet: vi.fn(),
  stageOutlinesPut: vi.fn(),
}));
vi.mock('@/lib/pbl/v2/runtime/hydration', () => ({
  hydratePBLScenesFromRuntime: (...args: unknown[]) => hydratePBLScenesFromRuntimeMock(...args),
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: async (...args: unknown[]) => {
    await saveStageDataMock(...args);
    const data = args[1] as { outline?: unknown };
    if (data.outline) await stageOutlinesPut(data.outline);
  },
  saveStageDataIncremental: vi.fn().mockResolvedValue(undefined),
  loadStageData: async (...args: unknown[]) => {
    const data = await loadStageDataMock(...args);
    if (!data) return data;
    const legacyOutline = await stageOutlinesGet(args[0]);
    return legacyOutline
      ? {
          ...data,
          outline: {
            ...(legacyOutline as object),
            createdAt: (legacyOutline as { createdAt?: number }).createdAt ?? Date.now(),
            updatedAt: (legacyOutline as { updatedAt?: number }).updatedAt ?? Date.now(),
          },
        }
      : data;
  },
}));
vi.mock('@/lib/utils/database', () => ({
  db: { stageOutlines: { put: stageOutlinesPut, get: stageOutlinesGet } },
}));

import { useStageStore } from '@/lib/store/stage';
import type { CourseBlueprint, SceneOutline } from '@/lib/types/generation';
import type { Stage } from '@/lib/types/stage';

function makeStage(id = 'stage-1'): Stage {
  return { id, name: 'Test stage', createdAt: 1, updatedAt: 1 };
}

function makeOutline(id: string, order: number): SceneOutline {
  return {
    id,
    type: 'slide',
    title: id,
    description: 'desc',
    keyPoints: ['k1'],
    order,
  };
}

function makeBlueprint(): CourseBlueprint {
  return {
    title: 'Test Course',
    languageDirective: 'English',
    durationMinutes: 30,
    audience: 'beginners',
    objectives: ['o1', 'o2'],
    courseType: 'explainer',
    lessonCount: 2,
    quizPlacement: 0,
    lessons: [
      {
        title: 'Lesson 1',
        objectives: ['l1o'],
        durationMinutes: 15,
        sceneTarget: 2,
        outlines: [makeOutline('outline-a', 1), makeOutline('outline-b', 2)],
      },
      {
        title: 'Lesson 2',
        objectives: ['l2o'],
        durationMinutes: 15,
        sceneTarget: 1,
        outlines: [makeOutline('outline-c', 3)],
      },
    ],
  };
}

beforeEach(() => {
  useStageStore.getState().clearStore();
  hydratePBLScenesFromRuntimeMock.mockReset();
  hydratePBLScenesFromRuntimeMock.mockImplementation(
    async (_stageId: string, scenes: unknown[]) => scenes,
  );
  stageOutlinesGet.mockReset();
  stageOutlinesPut.mockReset();
  loadStageDataMock.mockReset();
  saveStageDataMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  useStageStore.getState().clearStore();
});

describe('lessonGroups job model (Pillar 2)', () => {
  it('setBlueprint builds per-lesson groups with pending phases', () => {
    useStageStore.getState().setStage(makeStage());
    useStageStore.getState().setBlueprint(makeBlueprint());

    const groups = useStageStore.getState().lessonGroups;
    expect(groups.map((g) => g.lessonId)).toEqual(['lesson_1', 'lesson_2']);
    expect(groups[0].jobs.map((j) => j.outlineId)).toEqual(['outline-a', 'outline-b']);
    expect(groups[1].jobs.map((j) => j.outlineId)).toEqual(['outline-c']);
    for (const group of groups) {
      for (const job of group.jobs) {
        for (const phase of Object.values(job.phases)) {
          expect(phase.status).toBe('pending');
          expect(phase.attempts).toBe(0);
        }
      }
    }
  });

  it('recordScenePhase bumps attempts on running and stamps done/failed', () => {
    useStageStore.getState().setStage(makeStage());
    const store = useStageStore.getState();
    store.setBlueprint(makeBlueprint());

    store.recordScenePhase('outline-a', 'content', { status: 'running' });
    let phase = useStageStore.getState().lessonGroups[0].jobs[0].phases.content;
    expect(phase.status).toBe('running');
    expect(phase.attempts).toBe(1);

    store.recordScenePhase('outline-a', 'content', { status: 'done' });
    phase = useStageStore.getState().lessonGroups[0].jobs[0].phases.content;
    expect(phase.status).toBe('done');
    expect(phase.attempts).toBe(1);

    store.recordScenePhase('outline-c', 'actions', { status: 'running' });
    store.recordScenePhase('outline-c', 'actions', {
      status: 'failed',
      error: 'boom',
    });
    phase = useStageStore.getState().lessonGroups[1].jobs[0].phases.actions;
    expect(phase.status).toBe('failed');
    expect(phase.error).toBe('boom');
    expect(phase.attempts).toBe(1);
  });

  it('recordScenePhase falls back to a fresh group build when groups are empty', () => {
    useStageStore.getState().setStage(makeStage());
    useStageStore.getState().setBlueprint(makeBlueprint());
    useStageStore.setState({ lessonGroups: [] });

    useStageStore.getState().recordScenePhase('outline-b', 'tts', { status: 'running' });
    const groups = useStageStore.getState().lessonGroups;
    expect(groups).toHaveLength(2);
    expect(groups[0].jobs[1].phases.tts).toMatchObject({ status: 'running', attempts: 1 });
  });

  it('ignores unknown outlines and missing stage/blueprint', () => {
    useStageStore.getState().recordScenePhase('nope', 'content', { status: 'running' });
    expect(useStageStore.getState().lessonGroups).toEqual([]);

    useStageStore.getState().setStage(makeStage());
    useStageStore.getState().setBlueprint(makeBlueprint());
    const before = useStageStore.getState().lessonGroups;
    useStageStore.getState().recordScenePhase('unknown', 'content', { status: 'running' });
    expect(useStageStore.getState().lessonGroups).toEqual(before);
  });

  it('re-setting the blueprint preserves live phase history by outline id', () => {
    useStageStore.getState().setStage(makeStage());
    const store = useStageStore.getState();
    store.setBlueprint(makeBlueprint());
    store.recordScenePhase('outline-a', 'content', { status: 'running' });
    store.recordScenePhase('outline-a', 'content', { status: 'done' });

    // Same contract again (corrective re-stream path).
    store.setBlueprint(makeBlueprint());
    const phase = useStageStore.getState().lessonGroups[0].jobs[0].phases.content;
    expect(phase.status).toBe('done');
    expect(phase.attempts).toBe(1);
    // Untouched jobs still fresh-pending.
    expect(useStageStore.getState().lessonGroups[1].jobs[0].phases.content.status).toBe('pending');
  });

  it('saveToStorage carries lessonGroups in the outline envelope', async () => {
    useStageStore.setState({ stage: makeStage(), outlines: [makeOutline('outline-a', 1)] });
    useStageStore.getState().setBlueprint(makeBlueprint());

    await expect(useStageStore.getState().saveToStorage()).resolves.toBe(true);
    expect(saveStageDataMock).toHaveBeenLastCalledWith(
      'stage-1',
      expect.objectContaining({
        outline: expect.objectContaining({
          blueprint: expect.objectContaining({ title: 'Test Course' }),
          lessonGroups: expect.arrayContaining([
            expect.objectContaining({ lessonId: 'lesson_1' }),
          ]),
        }),
      }),
      expect.any(Number),
    );
  });

  it('load builds groups from the persisted blueprint when none are stored', async () => {
    loadStageDataMock.mockResolvedValue({
      stage: makeStage(),
      scenes: [],
      currentSceneId: null,
      chats: [],
      outline: {
        outlines: [makeOutline('outline-a', 1), makeOutline('outline-b', 2), makeOutline('outline-c', 3)],
        blueprint: makeBlueprint(),
        createdAt: 1,
        updatedAt: 1,
      },
    });

    await useStageStore.getState().loadFromStorage('stage-1');
    const groups = useStageStore.getState().lessonGroups;
    expect(groups.map((g) => g.lessonId)).toEqual(['lesson_1', 'lesson_2']);
    expect(groups[0].jobs[0].phases.content.status).toBe('pending');
  });

  it('load respects persisted groups and demotes stale running phases', async () => {
    loadStageDataMock.mockResolvedValue({
      stage: makeStage(),
      scenes: [],
      currentSceneId: null,
      chats: [],
      outline: {
        outlines: [makeOutline('outline-a', 1)],
        blueprint: makeBlueprint(),
        lessonGroups: [
          {
            lessonId: 'lesson_1',
            jobs: [
              {
                outlineId: 'outline-a',
                phases: {
                  content: { status: 'done', attempts: 1, updatedAt: 1 },
                  actions: { status: 'running', attempts: 1, updatedAt: 1 },
                  tts: { status: 'pending', attempts: 0, updatedAt: 1 },
                  media: { status: 'failed', attempts: 2, updatedAt: 1, error: 'x' },
                },
              },
            ],
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
    });

    await useStageStore.getState().loadFromStorage('stage-1');
    const phases = useStageStore.getState().lessonGroups[0].jobs[0].phases;
    expect(phases.content).toMatchObject({ status: 'done', attempts: 1 });
    // Interrupted by the reload — demoted so resume re-runs it.
    expect(phases.actions).toMatchObject({ status: 'pending', attempts: 1 });
    expect(phases.tts.status).toBe('pending');
    // Terminal failure survives recovery untouched.
    expect(phases.media).toMatchObject({ status: 'failed', attempts: 2 });
  });
});
