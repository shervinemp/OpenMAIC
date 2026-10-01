import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({ settingsState: vi.fn() }));

vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: () => ({}),
  getStageRoutesHeaderValue: () => undefined,
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settingsState },
}));
vi.mock('@/lib/utils/database', () => ({
  db: {
    audioFiles: {
      put: vi.fn(),
      get: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
  },
}));
vi.mock('@/lib/audio/provider-enablement', () => ({ isTTSProviderEnabled: () => false }));
vi.mock('@/lib/audio/agent-voice', () => ({
  pickNarratorAgent: () => undefined,
  resolveAgentVoiceOptions: async () => ({}),
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ listAgents: () => [] }) },
}));
vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }));

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

const outline = (id: string, order: number): SceneOutline =>
  ({ id, type: 'slide', title: id, description: 'd', keyPoints: ['k'], order }) as SceneOutline;

const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
const scene = (id: string, order: number, speech: string[] = []): Scene =>
  ({
    id,
    stageId: 'stage-1',
    type: 'slide',
    title: id,
    order,
    outlineId: `o-${id}`,
    content: {
      type: 'slide',
      canvas: { id: 'c', elements: [{ id: 'el-1', type: 'text', content: `<p>${words}</p>` }] },
    },
    actions: speech.map((text, i) => ({ id: `${id}-a${i}`, type: 'speech', text })),
  }) as unknown as Scene;

const ok = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body });

describe('narrateSilentScenes', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    mocks.settingsState.mockReturnValue({
      ttsEnabled: false,
      ttsProviderId: 'server-tts',
      ttsProvidersConfig: {},
      imageProvidersConfig: {},
      videoProvidersConfig: {},
      parallelSceneConcurrency: 0,
    });
    const { useStageStore } = await import('@/lib/store/stage');
    useStageStore.setState({
      stage: { id: 'stage-1', name: 'Course' } as never,
      scenes: [
        scene('s1', 1, ['Earlier line.']),
        scene('s2', 2),
        scene('s3', 3, ['Already spoken.']),
      ],
      outlines: [outline('o-s1', 1), outline('o-s2', 2), outline('o-s3', 3)],
    });
  });

  const run = async (sceneIds: string[], signal = new AbortController().signal) => {
    const { narrateSilentScenes } = await import('@/lib/hooks/use-scene-generator');
    return narrateSilentScenes({ sceneIds, params: {}, signal });
  };

  it('writes narration for a silent slide, drops dead anchors, and hands the model what came before', async () => {
    mockFetch.mockImplementation(async () =>
      ok({
        success: true,
        scene: {
          actions: [
            { id: 'n1', type: 'spotlight', elementId: 'el-1' },
            { id: 'n2', type: 'speech', text: 'Here is the worked solution.' },
            { id: 'n3', type: 'spotlight', elementId: 'gone-element' },
          ],
        },
      }),
    );

    const result = await run(['s2']);

    expect(result).toMatchObject({ narrated: 1, failed: 0, skipped: 0, audio: false });
    const { useStageStore } = await import('@/lib/store/stage');
    const written = useStageStore.getState().scenes.find((s) => s.id === 's2')!;
    expect((written.actions ?? []).map((a) => a.id)).toEqual(['n1', 'n2']);
    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    expect(body.previousSpeeches).toEqual(['Earlier line.']);
    expect(body.content).toEqual(written.content);
  });

  it('leaves a slide that already speaks, and one with no outline, alone', async () => {
    const { useStageStore } = await import('@/lib/store/stage');
    useStageStore.setState((s) => ({
      scenes: [...s.scenes, { ...scene('s4', 4), outlineId: 'o-missing' } as Scene],
    }));

    const result = await run(['s3', 's4']);

    expect(result).toMatchObject({ narrated: 0, skipped: 2 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('counts a model answer with no speech as failed and leaves the slide as it was', async () => {
    mockFetch.mockImplementation(async () =>
      ok({
        success: true,
        scene: { actions: [{ id: 'n1', type: 'spotlight', elementId: 'el-1' }] },
      }),
    );

    const result = await run(['s2']);

    expect(result).toMatchObject({ narrated: 0, failed: 1 });
    const { useStageStore } = await import('@/lib/store/stage');
    expect(useStageStore.getState().scenes.find((s) => s.id === 's2')!.actions).toEqual([]);
  });

  it('stops between slides when aborted and keeps what was finished', async () => {
    const controller = new AbortController();
    const { useStageStore } = await import('@/lib/store/stage');
    useStageStore.setState((state) => ({
      scenes: [...state.scenes, scene('s5', 5)],
      outlines: [...state.outlines, outline('o-s5', 5)],
    }));
    mockFetch.mockImplementation(async () =>
      ok({ success: true, scene: { actions: [{ id: 'n1', type: 'speech', text: 'First.' }] } }),
    );
    const { narrateSilentScenes } = await import('@/lib/hooks/use-scene-generator');

    const result = await narrateSilentScenes({
      sceneIds: ['s2', 's5'],
      params: {},
      signal: controller.signal,
      // The owner presses Stop after the first slide is written.
      onProgress: ({ done }) => {
        if (done === 1) controller.abort();
      },
    });

    expect(result.narrated).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(useStageStore.getState().scenes.find((x) => x.id === 's2')!.actions).toHaveLength(1);
    expect(useStageStore.getState().scenes.find((x) => x.id === 's5')!.actions).toEqual([]);
  });

  it('reports progress after every slide', async () => {
    mockFetch.mockImplementation(async () =>
      ok({ success: true, scene: { actions: [{ id: 'n1', type: 'speech', text: 'Line.' }] } }),
    );
    const progress: Array<{ done: number; total: number }> = [];
    const { narrateSilentScenes } = await import('@/lib/hooks/use-scene-generator');
    await narrateSilentScenes({
      sceneIds: ['s2', 's3'],
      params: {},
      signal: new AbortController().signal,
      onProgress: ({ done, total }) => progress.push({ done, total }),
    });
    expect(progress).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });
});
