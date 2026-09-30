// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

/**
 * Phase order is cost order: the token-free semantics gate runs before the
 * paid narration and media steps, so a scene it refuses is never voiced, and
 * a retry never reuses content that was generated from an older plan.
 */

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
vi.mock('@/lib/audio/provider-enablement', () => ({ isTTSProviderEnabled: () => true }));
vi.mock('@/lib/audio/agent-voice', () => ({
  pickNarratorAgent: () => undefined,
  resolveAgentVoiceOptions: async () => ({}),
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ listAgents: () => [] }) },
}));
vi.mock('@/lib/media/media-orchestrator', () => ({
  generateMediaForOutlines: vi.fn(async () => undefined),
}));
vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }));

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

const outline = {
  id: 'outline-1',
  type: 'interactive',
  title: 'Widget',
  description: 'An interactive widget',
  keyPoints: ['k'],
  order: 1,
} as SceneOutline;

const brokenWidgetScene = {
  id: 'scene-1',
  stageId: 'stage-1',
  outlineId: outline.id,
  type: 'interactive',
  title: 'Widget',
  order: 1,
  content: { type: 'interactive', html: '<script>function (</script>' },
  actions: [{ id: 'speech-1', type: 'speech', text: 'Hello class.' }],
} as unknown as Scene;

const okSlideScene = {
  id: 'scene-2',
  stageId: 'stage-1',
  outlineId: outline.id,
  type: 'slide',
  title: 'Slide',
  order: 1,
  content: { type: 'slide', canvas: { id: 'c', elements: [] } },
  actions: [{ id: 'speech-1', type: 'speech', text: 'Hello class.' }],
} as unknown as Scene;

const ok = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body });

function input(overrides: Record<string, unknown> = {}) {
  return {
    outline,
    allOutlines: [outline],
    params: { stageInfo: { name: 'Course' } },
    signal: new AbortController().signal,
    mode: 'generate' as const,
    previousSpeeches: [],
    ...overrides,
  };
}

describe('runOutlineJob cost order', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    mocks.settingsState.mockReturnValue({
      imageProvidersConfig: {},
      videoProvidersConfig: {},
      ttsEnabled: true,
      ttsProviderId: 'server-tts',
      ttsProvidersConfig: { 'server-tts': { apiKey: 'k', modelId: 'm' } },
      ttsVoice: 'narrator',
      ttsSpeed: 1,
      parallelSceneConcurrency: 0,
    });
    const { useStageStore } = await import('@/lib/store/stage');
    useStageStore.setState({
      stage: { id: 'stage-1', name: 'Course' } as never,
      scenes: [],
      failedOutlines: [],
    });
  });

  it('refuses a scene at the free semantics gate before any narration is paid for', async () => {
    const { runOutlineJob } = await import('@/lib/hooks/use-scene-generator');
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/generate/scene-actions')
        return ok({ success: true, scene: brokenWidgetScene });
      return ok({ success: true, base64: 'AAAA', format: 'mp3' });
    });

    const result = await runOutlineJob(
      input({ preComputedContent: { success: true, content: brokenWidgetScene.content } }),
    );

    expect(result.success).toBe(false);
    expect(result.failedPhase).toBe('semantics');
    // The scene is kept for the card, but no TTS request was ever made.
    expect(result.scene?.id).toBe('scene-1');
    const spent = mockFetch.mock.calls.filter(([url]) => url !== '/api/generate/scene-actions');
    expect(spent).toHaveLength(0);
  });

  it('stamps the plan the scene was generated from', async () => {
    const { runOutlineJob } = await import('@/lib/hooks/use-scene-generator');
    const { outlineFingerprint } = await import('@/lib/utils/outline-fingerprint');
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/generate/scene-actions') return ok({ success: true, scene: okSlideScene });
      return ok({ success: true, base64: 'AAAA', format: 'mp3' });
    });

    const result = await runOutlineJob(
      input({ preComputedContent: { success: true, content: okSlideScene.content } }),
    );

    expect(result.scene?.outlineSourceHash).toBe(outlineFingerprint(outline));
  });

  it('regenerates content on retry when the plan changed, and reuses it when it did not', async () => {
    const { runOutlineJob } = await import('@/lib/hooks/use-scene-generator');
    const { useStageStore } = await import('@/lib/store/stage');
    const { computeActionsSourceHash } = await import('@/lib/utils/content-hash');
    const { outlineFingerprint } = await import('@/lib/utils/outline-fingerprint');
    const params = { stageInfo: { name: 'Course' } } as never;
    const hash = computeActionsSourceHash({
      content: okSlideScene.content,
      agents: undefined,
      userProfile: undefined,
      languageDirective: undefined,
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/generate/scene-content') {
        return ok({ success: true, content: okSlideScene.content });
      }
      if (url === '/api/generate/scene-actions') return ok({ success: true, scene: okSlideScene });
      return ok({ success: true, base64: 'AAAA', format: 'mp3' });
    });
    const contentCalls = () =>
      mockFetch.mock.calls.filter(([url]) => url === '/api/generate/scene-content').length;

    useStageStore.setState({
      scenes: [
        {
          ...okSlideScene,
          actionsSourceHash: hash,
          outlineSourceHash: outlineFingerprint(outline),
        },
      ],
    });
    await runOutlineJob(input({ mode: 'repair', params }));
    expect(contentCalls()).toBe(0); // same plan: settled content is reused

    useStageStore.setState({
      scenes: [{ ...okSlideScene, actionsSourceHash: hash, outlineSourceHash: 'an-older-plan' }],
    });
    await runOutlineJob(input({ mode: 'repair', params }));
    expect(contentCalls()).toBe(1); // plan moved: content is generated again
  });
});
