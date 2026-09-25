import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Byte-aware narration repair (lib/hooks/use-scene-generator.ts).
 *
 * The contract under test:
 *
 *  - `drainPendingSceneTTS` probes each speech action's audioId through the
 *    player's own resolution chain (resolveAudioBlob). A ref with bytes is
 *    NEVER re-rendered; a ref without bytes is regenerated.
 *  - Per-action failure containment: recovered clips survive a partial pass;
 *    the clip that failed reverts to its previous persisted ref (no
 *    stripping, no fake success).
 *  - A fully resolving scene is skipped: zero provider calls.
 */

const mocks = vi.hoisted(() => ({
  updateScene: vi.fn(),
  setRepairActive: vi.fn(),
  retryFailedOutline: vi.fn(),
  settingsState: vi.fn(),
  fetch: vi.fn(),
}));

/** Per-test narration byte store: what the provider put makes resolvable. */
const audioBytes = new Map<string, Blob>();
const ttsCalls: Array<{ audioId: string; text: string; voice: string }> = [];
/** Speech text bodies whose provider response should fail (per-test). */
const failingTexts = new Set<string>();

vi.mock('@/lib/store/stage', () => ({
  useStageStore: {
    getState: () => ({
      updateScene: mocks.updateScene,
      setRepairActive: mocks.setRepairActive,
      retryFailedOutline: mocks.retryFailedOutline,
    }),
  },
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settingsState },
}));

vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ listAgents: () => [] }) },
}));

vi.mock('@/lib/audio/agent-voice', () => ({
  pickNarratorAgent: () => null,
  resolveAgentVoiceOptions: vi.fn(async () => ({})),
}));

vi.mock('@/lib/audio/voice-resolver', () => ({
  resolveNarratorVoiceBinding: () => ({ providerId: 'custom-provider', voiceId: 'alloy' }),
  getEnabledProvidersWithVoices: () => [],
  resolveDeterministicFallbackVoice: () => null,
}));

vi.mock('@/lib/audio/audio-duration', () => ({
  measureAudioDuration: () => null,
}));

vi.mock('@/lib/media/resolve-audio-bytes', () => ({
  resolveAudioBlob: vi.fn(async (audioId: string) => {
    if (!audioId) return null;
    const blob = audioBytes.get(audioId);
    return blob && blob.size > 0 ? blob : null;
  }),
}));

vi.mock('@/lib/utils/database', () => ({
  db: {
    audioFiles: {
      put: vi.fn(async (row: { id: string; blob: Blob }) => {
        // The store write makes the bytes resolvable on the fallback chain
        // (resolveAudioBlob above reads the same source of truth).
        audioBytes.set(row.id, row.blob);
      }),
      get: vi.fn(async (id: string) => {
        const blob = audioBytes.get(id);
        return blob ? { id, blob } : undefined;
      }),
      delete: vi.fn(async (id: string) => {
        audioBytes.delete(id);
      }),
    },
    mediaFiles: { put: vi.fn(), get: vi.fn(), delete: vi.fn() },
  },
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
}));

vi.mock('@/lib/media/media-orchestrator', () => ({
  generateMediaForOutlines: vi.fn(),
}));

vi.mock('@/lib/audio/unavailable-voice-bindings', () => ({
  isVoiceBindingUnavailable: () => false,
  markVoiceBindingNoticeShown: () => false,
  markVoiceBindingUnavailable: () => undefined,
  voiceBindingKey: (v: unknown) => JSON.stringify(v),
}));

vi.mock('@/lib/audio/constants', () => ({
  resolveTTSModelForVoice: () => undefined,
  TTS_PROVIDERS: {},
  TTS_MAX_TEXT_LENGTH: {},
}));

vi.mock('@/lib/audio/provider-enablement', () => ({
  isTTSProviderEnabled: () => true,
  BROWSER_NATIVE_TTS_PROVIDER_ID: 'browser-native-tts',
}));

vi.mock('@openmaic/generation', () => ({
  isAbortError: (err: unknown) => (err as { name?: string })?.name === 'AbortError',
  withGenerationRetry: (fn: () => Promise<unknown>) => fn(),
}));

import { drainPendingSceneTTS } from '@/lib/hooks/use-scene-generator';

function makeScene(
  id: string,
  order: number,
  actions: Array<{ audioId?: string }>,
): {
  id: string;
  order: number;
  stageId: string;
  title: string;
  actions: Array<Record<string, unknown>>;
} {
  return {
    id,
    order,
    stageId: 'stage-1',
    title: `Scene ${order}`,
    actions: actions.map((_a, i) => ({
      type: 'speech',
      id: `a${i}`,
      text: `clip ${i} for scene ${order}`,
      ...(actions[i]?.audioId ? { audioId: actions[i].audioId } : {}),
    })),
  };
}

function baseSettings(): Record<string, unknown> {
  return {
    ttsEnabled: true,
    ttsProviderId: 'custom-provider',
    ttsProvidersConfig: {
      'custom-provider': { baseUrl: 'http://localhost:8080', enabled: true },
    },
    parallelSceneConcurrency: 0,
    ttsSpeed: 1,
  };
}

describe('drainPendingSceneTTS — byte-aware, per-clip repair', () => {
  beforeEach(() => {
    audioBytes.clear();
    ttsCalls.length = 0;
    failingTexts.clear();
    mocks.updateScene.mockReset();
    mocks.settingsState.mockReset().mockReturnValue(baseSettings());
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        audioId: string;
        text: string;
        ttsVoice: string;
      };
      ttsCalls.push({ audioId: body.audioId, text: body.text, voice: body.ttsVoice });
      if (failingTexts.has(body.text)) {
        // Non-retryable on purpose: this suite pins per-clip containment, not
        // the retry classifier (a 5xx is retried with backoff first).
        return new Response(JSON.stringify({ error: 'TTS failed' }), { status: 400 });
      }
      const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
      audioBytes.set(body.audioId, blob);
      return new Response(
        JSON.stringify({
          success: true,
          base64: Buffer.from('audio-bytes').toString('base64'),
          format: 'wav',
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('regenerates ONLY the dead clip of a partially damaged scene; the healthy one keeps its id', async () => {
    const scene = makeScene('s1', 1, [{ audioId: 'tts_s1_healthy' }, { audioId: 'tts_s1_dead' }]);
    audioBytes.set('tts_s1_healthy', new Blob([new Uint8Array([7, 7])]));
    // 'tts_s1_dead' intentionally resolves to nothing.

    const restored = await drainPendingSceneTTS([scene as never], undefined);

    expect(restored).toBe(1);
    expect(ttsCalls).toHaveLength(1);
    expect(ttsCalls[0].text).toBe('clip 1 for scene 1');
    expect((scene.actions[0] as { audioId?: string }).audioId).toBe('tts_s1_healthy');
    expect((scene.actions[1] as { audioId?: string }).audioId).toMatch(/^tts_/);
    expect(mocks.updateScene).toHaveBeenCalledWith(scene.id, { actions: scene.actions });
  });

  it('a fully resolving scene exists: no provider calls', async () => {
    const scene = makeScene('s1', 1, [{ audioId: 'tts_ok' }]);
    audioBytes.set('tts_ok', new Blob([new Uint8Array([7, 7])]));

    const restored = await drainPendingSceneTTS([scene as never]);

    expect(restored).toBe(0);
    expect(ttsCalls).toHaveLength(0);
    expect(mocks.updateScene).not.toHaveBeenCalled();
  });

  it('partial failure keeps every recovered clip; the failed clip reverts to its persisted ref', async () => {
    failingTexts.add('clip 1 for scene 1');
    const scene = makeScene('s1', 1, [{ audioId: 'tts_s1_dead_a' }, { audioId: 'tts_s1_dead_b' }]);

    const restored = await drainPendingSceneTTS([scene as never]);

    expect(restored).toBe(1);
    expect(ttsCalls).toHaveLength(2);
    expect((scene.actions[0] as { audioId?: string }).audioId).toMatch(/^tts_/);
    expect((scene.actions[1] as { audioId?: string }).audioId).toBe('tts_s1_dead_b');
    // Persisted even though one clip is still dead: the recovered half is real.
    expect(mocks.updateScene).toHaveBeenCalledWith(scene.id, { actions: scene.actions });
  });

  it('a scene with NO audioIds generates fresh ids for all its clips', async () => {
    const scene = makeScene('s1', 1, [{}, {}]);

    const restored = await drainPendingSceneTTS([scene as never]);

    expect(restored).toBe(1);
    expect(ttsCalls).toHaveLength(2);
    expect((scene.actions[0] as { audioId?: string }).audioId).toMatch(/^tts_/);
    expect((scene.actions[1] as { audioId?: string }).audioId).toMatch(/^tts_/);
  });

  it('TTS being disabled short-circuits: no probing, no provider calls', async () => {
    mocks.settingsState.mockReturnValue({ ...baseSettings(), ttsEnabled: false });
    const scene = makeScene('s1', 1, [{}, {}]);
    const restored = await drainPendingSceneTTS([scene as never]);
    expect(restored).toBe(0);
    expect(ttsCalls).toHaveLength(0);
  });
});
