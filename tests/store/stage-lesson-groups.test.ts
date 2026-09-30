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

  it('accepts the sixth phase: semantics stamps like any other phase', () => {
    useStageStore.getState().setStage(makeStage());
    useStageStore.getState().setBlueprint(makeBlueprint());
    const store = useStageStore.getState();
    store.recordScenePhase('outline-a', 'semantics', { status: 'running' });
    store.recordScenePhase('outline-a', 'semantics', {
      status: 'done',
    });
    const phase = useStageStore.getState().lessonGroups[0].jobs[0].phases.semantics;
    expect(phase.status).toBe('done');
    expect(phase.attempts).toBe(1);
  });

  it('loader demotes a stale-running semantics phase to pending for resume', async () => {
    // The loader's stale-running recovery is generic over the phase map —
    // a crash mid-Semantics means a reload, not a dead transition.
    useStageStore.getState().setStage(makeStage());
    useStageStore.getState().setBlueprint(makeBlueprint());
    useStageStore.setState({
      lessonGroups: [
        {
          lessonId: 'lesson_1',
          jobs: [
            {
              outlineId: 'outline-a',
              phases: {
                content: { status: 'done', attempts: 1, updatedAt: 1 },
                actions: { status: 'done', attempts: 1, updatedAt: 1 },
                tts: { status: 'done', attempts: 1, updatedAt: 1 },
                media: { status: 'done', attempts: 1, updatedAt: 1 },
                layout: { status: 'done', attempts: 1, updatedAt: 1 },
                semantics: { status: 'running', attempts: 1, updatedAt: 1 },
              },
            },
          ],
        },
      ],
    });
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
          lessonGroups: expect.arrayContaining([expect.objectContaining({ lessonId: 'lesson_1' })]),
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
        outlines: [
          makeOutline('outline-a', 1),
          makeOutline('outline-b', 2),
          makeOutline('outline-c', 3),
        ],
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

  it('ONE QUEUE: fill-decay phase rows hydrate red cards for live scenes (and skips stay settled)', async () => {
    const sceneFor = (id: string, order: number, outlineId: string) => ({
      id,
      stageId: 'stage-1',
      type: 'slide',
      title: id,
      order,
      outlineId,
      content: {
        type: 'slide',
        canvas: {
          id: `canvas-${id}`,
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
    });
    loadStageDataMock.mockResolvedValue({
      stage: makeStage(),
      scenes: [sceneFor('scene-a', 1, 'outline-a'), sceneFor('scene-b', 2, 'outline-b')],
      currentSceneId: 'scene-a',
      chats: [],
      outline: {
        outlines: [makeOutline('outline-a', 1), makeOutline('outline-b', 2)],
        blueprint: makeBlueprint(),
        lessonGroups: [
          {
            lessonId: 'lesson_1',
            jobs: [
              {
                outlineId: 'outline-a',
                phases: {
                  content: { status: 'done', attempts: 1, updatedAt: 1 },
                  tts: { status: 'failed', attempts: 1, updatedAt: 1, error: 'bytes gone' },
                },
              },
              {
                // Skipped: ITS fill failure stays settled.
                outlineId: 'outline-b',
                resolution: 'skip',
                phases: {
                  content: { status: 'done', attempts: 1, updatedAt: 1 },
                  tts: { status: 'failed', attempts: 1, updatedAt: 1, error: 'bytes gone' },
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
    const state = useStageStore.getState();
    // A live scene's fill failure surfaces the same red regenerate card —
    // ONE queue, per-class rows; the skipped job stays settled.
    expect(state.failedOutlines.map((o) => o.id)).toEqual(['outline-a']);
    // Fill decay never demotes completion: the deck itself is whole.
    expect(state.generationComplete).toBe(true);
  });
});

describe('reconcilePlanStaleness', () => {
  const HASH = 'stale-plan-hash';

  async function seed(options: { stamp?: string | undefined } = { stamp: HASH }) {
    const { outlineFingerprint } = await import('@/lib/utils/outline-fingerprint');
    const store = useStageStore.getState();
    store.setStage(makeStage());
    const blueprint = makeBlueprint();
    store.setBlueprint(blueprint);
    const outline = blueprint.lessons[0].outlines[0];
    useStageStore.setState({
      outlines: blueprint.lessons.flatMap((lesson) => lesson.outlines),
      scenes: [
        {
          id: 'scene-a',
          stageId: 'stage-1',
          type: 'slide',
          title: 'A',
          order: 1,
          outlineId: 'outline-a',
          content: { type: 'slide', canvas: {} },
          ...(options.stamp === undefined
            ? {}
            : {
                outlineSourceHash: options.stamp === HASH ? HASH : outlineFingerprint(outline),
              }),
        } as never,
      ],
    });
    for (const phase of ['content', 'actions', 'semantics', 'tts'] as const) {
      useStageStore.getState().recordScenePhase('outline-a', phase, { status: 'done' });
    }
    return outline;
  }

  it('queues a scene whose plan changed: content failed, later steps pending, card raised', async () => {
    await seed();
    expect(useStageStore.getState().reconcilePlanStaleness()).toBe(1);

    const state = useStageStore.getState();
    const phases = state.lessonGroups[0].jobs[0].phases;
    expect(phases.content.status).toBe('failed');
    expect(phases.content.error).toContain('lesson plan');
    expect(phases.actions.status).toBe('pending');
    expect(phases.semantics.status).toBe('pending');
    expect(phases.tts.status).toBe('pending');
    expect(state.failedOutlines.map((o) => o.id)).toEqual(['outline-a']);
  });

  it('is idempotent: a second pass queues nothing and stacks nothing', async () => {
    await seed();
    useStageStore.getState().reconcilePlanStaleness();
    expect(useStageStore.getState().reconcilePlanStaleness()).toBe(0);
    expect(useStageStore.getState().failedOutlines).toHaveLength(1);
  });

  it('leaves a scene alone when its recorded plan still matches', async () => {
    await seed({ stamp: 'match' });
    expect(useStageStore.getState().reconcilePlanStaleness()).toBe(0);
    expect(useStageStore.getState().failedOutlines).toHaveLength(0);
    expect(useStageStore.getState().lessonGroups[0].jobs[0].phases.content.status).toBe('done');
  });

  it('leaves a scene with no recorded plan alone (it predates the stamp)', async () => {
    await seed({ stamp: undefined });
    expect(useStageStore.getState().reconcilePlanStaleness()).toBe(0);
    expect(useStageStore.getState().failedOutlines).toHaveLength(0);
  });

  it('does nothing while a generation is in flight, or for a skipped outline', async () => {
    await seed();
    useStageStore.setState({ generationStatus: 'generating' });
    expect(useStageStore.getState().reconcilePlanStaleness()).toBe(0);

    useStageStore.setState({ generationStatus: 'idle', skippedOutlineIds: ['outline-a'] });
    expect(useStageStore.getState().reconcilePlanStaleness()).toBe(0);
  });

  it('Skip keeps the scene as it is: plan adopted, finished steps restored, no re-queue', async () => {
    await seed();
    useStageStore.getState().reconcilePlanStaleness();
    useStageStore.getState().skipFailedOutline('outline-a');

    const state = useStageStore.getState();
    const phases = state.lessonGroups[0].jobs[0].phases;
    expect(phases.content.status).toBe('done');
    expect(phases.actions.status).toBe('done');
    expect(phases.tts.status).toBe('done');
    expect(state.failedOutlines).toHaveLength(0);
    expect(state.scenes[0].outlineSourceHash).not.toBe(HASH);
    // Adopted: a later reconcile sees a match.
    useStageStore.setState({ skippedOutlineIds: [] });
    expect(useStageStore.getState().reconcilePlanStaleness()).toBe(0);
  });
});

describe('settleInapplicableMedia', () => {
  function seed(mediaByOutline: Record<string, Array<{ elementId: string }>>, content = '') {
    const store = useStageStore.getState();
    store.setStage(makeStage());
    const blueprint = makeBlueprint();
    store.setBlueprint(blueprint);
    const outlines = blueprint.lessons
      .flatMap((lesson) => lesson.outlines)
      .map((outline) => ({
        ...outline,
        ...(mediaByOutline[outline.id]
          ? {
              mediaGenerations: mediaByOutline[outline.id].map((m) => ({
                type: 'image' as const,
                prompt: 'p',
                ...m,
              })),
            }
          : {}),
      }));
    useStageStore.setState({
      outlines,
      scenes: ['outline-a', 'outline-b'].map(
        (outlineId, index) =>
          ({
            id: `scene-${outlineId}`,
            stageId: 'stage-1',
            type: 'slide',
            title: outlineId,
            order: index + 1,
            outlineId,
            content: { type: 'slide', canvas: { elements: [{ src: content }] } },
          }) as never,
      ),
    });
  }
  const media = (id: string) =>
    useStageStore
      .getState()
      .lessonGroups.flatMap((g) => g.jobs)
      .find((j) => j.outlineId === id)!.phases.media;

  it('settles the step of a scene whose lesson asked for no media', () => {
    seed({});
    expect(useStageStore.getState().settleInapplicableMedia()).toBe(2);
    expect(media('outline-a').status).toBe('done');
    // outline-c has no scene yet, so nothing is settled for it.
    expect(media('outline-c').status).toBe('pending');
  });

  it('settles a request its slide never used, and keeps one it did', () => {
    seed(
      { 'outline-a': [{ elementId: 'gen_img_1' }], 'outline-b': [{ elementId: 'gen_img_2' }] },
      'gen_img_2',
    );
    useStageStore.setState((s) => ({
      scenes: s.scenes.map((scene) =>
        scene.outlineId === 'outline-a'
          ? ({
              ...scene,
              content: { type: 'slide', canvas: { elements: [{ src: 'other' }] } },
            } as never)
          : scene,
      ),
    }));

    expect(useStageStore.getState().settleInapplicableMedia()).toBe(1);
    expect(media('outline-a').status).toBe('done');
    expect(media('outline-b').status).toBe('pending');
  });

  it('leaves a step that ran, and does nothing while generating', () => {
    seed({});
    useStageStore.getState().recordScenePhase('outline-a', 'media', { status: 'running' });
    useStageStore.getState().recordScenePhase('outline-a', 'media', { status: 'pending' });
    expect(useStageStore.getState().settleInapplicableMedia()).toBe(1);
    expect(media('outline-a').status).toBe('pending');

    useStageStore.setState({ generationStatus: 'generating' });
    expect(useStageStore.getState().settleInapplicableMedia()).toBe(0);
  });

  it('a second pass settles nothing', () => {
    seed({});
    useStageStore.getState().settleInapplicableMedia();
    expect(useStageStore.getState().settleInapplicableMedia()).toBe(0);
  });
});
