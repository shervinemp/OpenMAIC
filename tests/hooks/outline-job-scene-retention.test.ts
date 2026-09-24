import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  settingsState: vi.fn(),
}));

vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: () => ({}),
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settingsState },
}));
vi.mock('@/lib/utils/database', () => ({
  db: { audioFiles: { put: vi.fn(), delete: vi.fn(async () => undefined) } },
}));
vi.mock('@/lib/audio/provider-enablement', () => ({
  isTTSProviderEnabled: () => true,
}));
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

const outline = {
  id: 'outline-tts',
  type: 'slide',
  title: 'Narrated scene',
  description: 'A scene whose narration fails',
  keyPoints: ['kept'],
  order: 1,
} as SceneOutline;

const scene = {
  id: 'scene-1',
  stageId: 'stage-1',
  outlineId: outline.id,
  type: 'slide',
  title: outline.title,
  order: 1,
  content: { type: 'slide', canvas: { id: 'c', elements: [] } },
  actions: [{ id: 'speech-1', type: 'speech', text: 'Hello class.' }],
} as unknown as Scene;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'X',
    json: async () => body,
  };
}

describe('runOutlineJob scene retention', () => {
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

  it('returns the materialized scene when only the TTS phase fails', async () => {
    const { runOutlineJob } = await import('@/lib/hooks/use-scene-generator');
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/generate/scene-actions') {
        return jsonResponse(200, { success: true, scene });
      }
      // Non-retryable provider failure for every narration clip.
      return jsonResponse(400, { error: 'voice rejected' });
    });

    const result = await runOutlineJob({
      outline,
      allOutlines: [outline],
      params: { stageInfo: { name: 'Course' } },
      signal: new AbortController().signal,
      mode: 'generate',
      previousSpeeches: [],
      preComputedContent: { success: true, content: scene.content },
    });

    expect(result.success).toBe(false);
    expect(result.failedPhase).toBe('tts');
    expect(result.scene?.id).toBe('scene-1');
    expect(result.scene?.actions?.[0]).not.toHaveProperty('audioId');
  });
});
