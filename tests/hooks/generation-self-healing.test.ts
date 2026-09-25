// @vitest-environment jsdom
// Keep the .test.ts suffix: the repository's Vitest include intentionally
// discovers TypeScript tests with this extension.

/**
 * The self-healing contract of the generation queue ("the one queue"):
 *
 * - A retry card drops only when nothing about its outline is still broken.
 * - Fill decay (narration/media behind a live scene) never holds a deck open.
 * - A repair job reports what its phases actually did.
 * - Parked failures stay parked unless a resume asks for them.
 * - stop() reaches every generation worker, retries included.
 */

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type {
  LessonJobGroup,
  OutlinePhaseName,
  OutlinePhaseState,
} from '@/lib/document-store/persistence-types';
import type { CourseBlueprint, SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  settingsState: vi.fn(),
  generateMedia: vi.fn(),
}));

vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: () => ({}),
  getStageRoutesHeaderValue: () => undefined,
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settingsState },
}));
vi.mock('@/lib/utils/database', () => ({
  db: { audioFiles: { put: vi.fn(), delete: vi.fn() } },
}));
vi.mock('@/lib/audio/provider-enablement', () => ({ isTTSProviderEnabled: () => false }));
vi.mock('@/lib/audio/agent-voice', () => ({
  pickNarratorAgent: () => undefined,
  resolveAgentVoiceOptions: () => ({}),
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ listAgents: () => [] }) },
}));
vi.mock('@/lib/media/media-orchestrator', () => ({
  generateMediaForOutlines: mocks.generateMedia,
}));
vi.mock('@/lib/classroom/generation-permission', () => ({ mayGenerateForStage: () => true }));
vi.mock('@/lib/utils/generation-session-store', () => ({
  loadGenerationParams: async () => ({}),
}));
vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }));

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

import { runOutlineJob, useSceneGenerator } from '@/lib/hooks/use-scene-generator';
import { useStageStore } from '@/lib/store/stage';
import { computeActionsSourceHash } from '@/lib/utils/content-hash';

const STAGE_ID = 'stage-heal';

function outline(order: number): SceneOutline {
  return {
    id: `outline-${order}`,
    type: 'slide',
    title: `Scene ${order}`,
    description: `Scene ${order}`,
    keyPoints: ['kept'],
    order,
  } as SceneOutline;
}

function scene(order: number): Scene {
  return {
    id: `scene-${order}`,
    stageId: STAGE_ID,
    outlineId: `outline-${order}`,
    type: 'slide',
    title: `Scene ${order}`,
    order,
    content: { type: 'slide', canvas: { id: `canvas-${order}`, elements: [] } },
    actions: [],
  } as unknown as Scene;
}

function phases(
  overrides: Partial<Record<OutlinePhaseName, OutlinePhaseState['status']>> = {},
): Record<OutlinePhaseName, OutlinePhaseState> {
  const names: OutlinePhaseName[] = ['content', 'actions', 'tts', 'media', 'layout', 'semantics'];
  return Object.fromEntries(
    names.map((name) => [name, { status: overrides[name] ?? 'done', attempts: 1, updatedAt: 1 }]),
  ) as Record<OutlinePhaseName, OutlinePhaseState>;
}

function groups(
  ...jobs: Array<[number, Partial<Record<OutlinePhaseName, OutlinePhaseState['status']>>]>
): LessonJobGroup[] {
  return [
    {
      lessonId: 'lesson_1',
      jobs: jobs.map(([order, overrides]) => ({
        outlineId: `outline-${order}`,
        phases: phases(overrides),
      })),
    },
  ];
}

function blueprintFor(outlines: SceneOutline[]): CourseBlueprint {
  return {
    lessons: [{ title: 'Lesson 1', objectives: [], outlines }],
  } as unknown as CourseBlueprint;
}

function landStage(state: Record<string, unknown>): void {
  useStageStore.setState({
    stage: { id: STAGE_ID, name: 'Course' } as never,
    scenes: [],
    outlines: [],
    failedOutlines: [],
    skippedOutlineIds: [],
    generatingOutlines: [],
    lessonGroups: [],
    blueprint: undefined,
    generationComplete: false,
    generationStatus: 'idle',
    ...state,
  } as never);
}

beforeEach(() => {
  mockFetch.mockReset();
  mocks.generateMedia.mockReset().mockResolvedValue(undefined);
  mocks.settingsState.mockReturnValue({
    ttsEnabled: false,
    ttsProviderId: 'browser-native-tts',
    ttsProvidersConfig: {},
    imageProvidersConfig: {},
    videoProvidersConfig: {},
    parallelSceneConcurrency: 0,
  });
});

describe('settleFailedOutline', () => {
  it('keeps the card while a sibling phase is still failed', () => {
    landStage({
      scenes: [scene(1)],
      outlines: [outline(1)],
      failedOutlines: [outline(1)],
      lessonGroups: groups([1, { tts: 'done', media: 'failed' }]),
    });

    useStageStore.getState().settleFailedOutline('outline-1');

    expect(useStageStore.getState().failedOutlines.map((o) => o.id)).toEqual(['outline-1']);
  });

  it('drops the card once the scene exists and no queue phase is failed', () => {
    landStage({
      scenes: [scene(1)],
      outlines: [outline(1)],
      failedOutlines: [outline(1)],
      // Layout debt is its own train and never pins a card.
      lessonGroups: groups([1, { layout: 'failed' }]),
    });

    useStageStore.getState().settleFailedOutline('outline-1');

    expect(useStageStore.getState().failedOutlines).toEqual([]);
  });

  it('never drops the card of an outline that has no scene', () => {
    landStage({
      outlines: [outline(1)],
      failedOutlines: [outline(1)],
      lessonGroups: groups([1, {}]),
    });

    useStageStore.getState().settleFailedOutline('outline-1');

    expect(useStageStore.getState().failedOutlines).toHaveLength(1);
  });
});

describe('completion with fill decay', () => {
  it('completes a fully materialized deck whose only card is decayed narration', () => {
    landStage({
      scenes: [scene(1), scene(2)],
      outlines: [outline(1), outline(2)],
      failedOutlines: [outline(2)],
      lessonGroups: groups([1, {}], [2, { tts: 'failed' }]),
    });

    useStageStore.getState().markGenerationCompleteIfDone();

    expect(useStageStore.getState().generationComplete).toBe(true);
  });

  it('stays open while an outline failed its content, even behind an older scene', () => {
    landStage({
      scenes: [scene(1), scene(2)],
      outlines: [outline(1), outline(2)],
      failedOutlines: [outline(2)],
      lessonGroups: groups([1, {}], [2, { content: 'failed' }]),
    });

    useStageStore.getState().markGenerationCompleteIfDone();

    expect(useStageStore.getState().generationComplete).toBe(false);
  });
});

describe('runOutlineJob in repair mode', () => {
  function jsonResponse(status: number, body: unknown) {
    return { ok: status < 300, status, statusText: 'X', json: async () => body };
  }

  it('reports a media failure the pass recorded instead of answering done', async () => {
    const target = outline(1);
    landStage({
      scenes: [scene(1)],
      outlines: [target],
      blueprint: blueprintFor([target]),
      lessonGroups: groups([1, {}]),
    });
    mockFetch.mockImplementation(async () => jsonResponse(200, { success: true, scene: scene(1) }));
    mocks.generateMedia.mockImplementation(async () => {
      useStageStore.getState().recordScenePhase(target.id, 'media', {
        status: 'failed',
        error: '1/1 media item(s) failed',
      });
    });

    const result = await runOutlineJob({
      outline: target,
      allOutlines: [target],
      params: { stageInfo: { name: 'Course' } },
      signal: new AbortController().signal,
      mode: 'repair',
      previousSpeeches: [],
      preComputedContent: { success: true, content: scene(1).content },
    });

    expect(result.success).toBe(false);
    expect(result.failedPhase).toBe('media');
    expect(result.error).toBe('1/1 media item(s) failed');
    expect(result.scene?.id).toBe('scene-1');
  });

  it('checks semantics on every run, however many attempts came before', async () => {
    const target = outline(1);
    landStage({
      scenes: [scene(1)],
      outlines: [target],
      blueprint: blueprintFor([target]),
      lessonGroups: [
        {
          lessonId: 'lesson_1',
          jobs: [
            {
              outlineId: target.id,
              phases: { ...phases(), semantics: { status: 'failed', attempts: 9, updatedAt: 1 } },
            },
          ],
        },
      ],
    });
    mockFetch.mockImplementation(async () => jsonResponse(200, { success: true, scene: scene(1) }));

    const result = await runOutlineJob({
      outline: target,
      allOutlines: [target],
      params: { stageInfo: { name: 'Course' } },
      signal: new AbortController().signal,
      mode: 'repair',
      previousSpeeches: [],
      preComputedContent: { success: true, content: scene(1).content },
    });

    expect(result.success).toBe(true);
    const job = useStageStore.getState().lessonGroups[0]!.jobs[0]!;
    expect(job.phases.semantics.status).toBe('done');
  });
});

describe('useSceneGenerator', () => {
  type Api = ReturnType<typeof useSceneGenerator>;
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  async function mountGenerator(): Promise<Api> {
    let api: Api | undefined;
    function Harness({ onReady }: { onReady: (value: Api) => void }) {
      const generator = useSceneGenerator();
      useEffect(() => onReady(generator), [generator, onReady]);
      return null;
    }
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(Harness, {
          onReady: (value: Api) => {
            api = value;
          },
        }),
      );
    });
    return api!;
  }

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    container = undefined;
  });

  it('leaves parked failures parked when the resume does not include them', async () => {
    landStage({
      scenes: [scene(2)],
      outlines: [outline(1), outline(2)],
      failedOutlines: [outline(1)],
    });
    const api = await mountGenerator();

    await act(async () => {
      await api.generateRemaining({ stageInfo: { name: 'Course' } }, { includeFailed: false });
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(useStageStore.getState().generationStatus).toBe('paused');
    expect(useStageStore.getState().generationComplete).toBe(false);
    expect(useStageStore.getState().failedOutlines.map((o) => o.id)).toEqual(['outline-1']);
  });

  it('stop() aborts a retry that is in flight', async () => {
    landStage({ outlines: [outline(1)], failedOutlines: [outline(1)] });
    let retrySignal: AbortSignal | undefined;
    mockFetch.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          retrySignal = init?.signal ?? undefined;
          retrySignal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const api = await mountGenerator();

    let retry: Promise<void> | undefined;
    await act(async () => {
      retry = api.retrySingleOutline('outline-1');
      for (let tick = 0; tick < 20 && !retrySignal; tick += 1) await Promise.resolve();
    });
    expect(retrySignal).toBeDefined();
    expect(retrySignal?.aborted).toBe(false);

    await act(async () => {
      api.stop();
      await retry;
    });

    expect(retrySignal?.aborted).toBe(true);
  });

  // An edited, unfinished deck: outline 1's slide deleted, then outline 3's
  // slide dragged to the front (a reorder renumbers scenes, not outlines).
  it('resumes the outline that lost its slide, not the one whose slide moved', async () => {
    const moved = { ...scene(3), order: 1 };
    landStage({
      scenes: [moved, scene(2)],
      outlines: [outline(1), outline(2), outline(3)],
    });
    const requested: string[] = [];
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { outline?: { id?: string } };
      if (body.outline?.id) requested.push(body.outline.id);
      return { ok: false, status: 400, statusText: 'X', json: async () => ({ error: 'stop' }) };
    });
    const api = await mountGenerator();

    await act(async () => {
      await api.generateRemaining({ stageInfo: { name: 'Course' } });
    });

    expect(requested).toEqual(['outline-1']);
  });
});

describe('runOutlineJob on an edited deck', () => {
  it('reuses the content of its own slide, wherever the reorder put it', async () => {
    const withContent = (order: number, position: number, canvasId: string): Scene => {
      const base = { ...scene(order), order: position };
      const content = { type: 'slide', canvas: { id: canvasId, elements: [] } };
      return {
        ...base,
        content,
        // The same inputs the runner hashes (no agents/profile/directive).
        actionsSourceHash: computeActionsSourceHash({
          content,
          agents: undefined,
          userProfile: undefined,
          languageDirective: undefined,
        }),
      } as unknown as Scene;
    };
    // Swapped by a drag: outline 1's slide now sits at position 2.
    const own = withContent(1, 2, 'canvas-own');
    const other = withContent(2, 1, 'canvas-other');
    const target = outline(1);
    landStage({
      scenes: [other, own],
      outlines: [target, outline(2)],
      blueprint: blueprintFor([target, outline(2)]),
      lessonGroups: groups([1, {}], [2, {}]),
    });

    const result = await runOutlineJob({
      outline: target,
      allOutlines: [target, outline(2)],
      params: { stageInfo: { name: 'Course' } },
      signal: new AbortController().signal,
      mode: 'repair',
      previousSpeeches: [],
    });

    expect(result.success).toBe(true);
    expect((result.scene?.content as { canvas: { id: string } }).canvas.id).toBe('canvas-own');
    // Its own slide's actions are reused too: nothing is paid for again.
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
