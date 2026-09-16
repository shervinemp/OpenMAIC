'use client';

import { useCallback, useRef } from 'react';
import { useStageStore } from '@/lib/store/stage';
import { isSceneEditLocked } from '@/lib/edit/regen-lock';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useSettingsStore } from '@/lib/store/settings';
import { db } from '@/lib/utils/database';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  UserRequirements,
} from '@/lib/types/generation';
import type { AgentInfo } from '@openmaic/generation';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { measureAudioDuration } from '@/lib/audio/audio-duration';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { loadImageMapping } from '@/lib/utils/image-storage';
import { resolveAgentVoiceOptions, pickNarratorAgent } from '@/lib/audio/agent-voice';
import {
  getEnabledProvidersWithVoices,
  resolveDeterministicFallbackVoice,
  resolveNarratorVoiceBinding,
  type ResolvedVoice,
} from '@/lib/audio/voice-resolver';
import { resolveTTSModelForVoice } from '@/lib/audio/constants';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { lazyBoundedMap } from '@/lib/utils/concurrency';
import { computeActionsSourceHash } from '@/lib/utils/content-hash';
import { verifyAndRepairSlideLayout } from '@/lib/slides/slide-layout-verify';
import { createLogger } from '@/lib/logger';
import { toast } from 'sonner';
import { getClientTranslation } from '@/lib/i18n';
import {
  isVoiceBindingUnavailable,
  markVoiceBindingNoticeShown,
  markVoiceBindingUnavailable,
  voiceBindingKey,
} from '@/lib/audio/unavailable-voice-bindings';
import {
  isAbortError,
  withGenerationRetry,
  type GenerationRetryOptions,
} from '@openmaic/generation';

const log = createLogger('SceneGenerator');

/**
 * Cross-tab generation lease (Web Locks API).
 *
 * Every mounted classroom tab that sees pending outlines resumes generation
 * — a second open tab of the same course would re-run the whole loop and
 * duplicate every provider call (content, actions, TTS, media) against the
 * user's API key. The lease serializes that to one tab per stage: claimants
 * that lose the race skip their own resume and let the holder drive, while
 * the document store keeps every tab reading the same landing scenes.
 *
 * Degrades to a no-op release (so single-tab browsers behave exactly as
 * before) when Web Locks are unavailable.
 */
async function claimGenerationLease(stageId: string): Promise<(() => void) | null> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return () => {};
  }
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return new Promise<(() => void) | null>((resolveOuter) => {
    void navigator.locks
      .request(
        `openmaic-generate:${stageId}`,
        { ifAvailable: true },
        (lock: unknown) => {
          if (!lock) {
            resolveOuter(null);
            return undefined;
          }
          resolveOuter(() => release());
          return parked as unknown as Promise<void>;
        },
      )
      .catch((error) => {
        log.error('Generation lease request failed:', error);
        resolveOuter(() => release());
      });
  });
}

interface SceneContentResult {
  success: boolean;
  content?: unknown;
  effectiveOutline?: SceneOutline;
  error?: string;
  errorCode?: string;
  statusCode?: number;
  /** Depth summary (reworked/attempts) from the depth-affordance transport. */
  depth?: import('@/lib/generation/content-depth').SceneDepthSummary;
}

interface SceneActionsResult {
  success: boolean;
  scene?: Scene;
  previousSpeeches?: string[];
  error?: string;
  errorCode?: string;
  statusCode?: number;
}

type ClientRetryOptions<T> = Partial<
  Omit<GenerationRetryOptions<T>, 'label' | 'shouldRetryResult' | 'signal'>
>;

function getApiHeaders(): HeadersInit {
  const config = getCurrentModelConfig();
  const settings = useSettingsStore.getState();
  const imageProviderConfig = settings.imageProvidersConfig?.[settings.imageProviderId];
  const videoProviderConfig = settings.videoProvidersConfig?.[settings.videoProviderId];

  return {
    'Content-Type': 'application/json',
    'x-model': config.modelString || '',
    'x-api-key': config.apiKey || '',
    'x-base-url': config.baseUrl || '',
    'x-provider-type': config.providerType || '',
    // Image generation provider
    'x-image-provider': settings.imageProviderId || '',
    'x-image-model': settings.imageModelId || '',
    'x-image-api-key': imageProviderConfig?.apiKey || '',
    'x-image-base-url': imageProviderConfig?.baseUrl || '',
    // Video generation provider
    'x-video-provider': settings.videoProviderId || '',
    'x-video-model': settings.videoModelId || '',
    'x-video-api-key': videoProviderConfig?.apiKey || '',
    'x-video-base-url': videoProviderConfig?.baseUrl || '',
    // Media generation toggles
    'x-image-generation-enabled': String(settings.imageGenerationEnabled ?? false),
    'x-video-generation-enabled': String(settings.videoGenerationEnabled ?? false),
  };
}

function withThinkingConfig<T extends Record<string, unknown>>(body: T): T {
  const { thinkingConfig } = getCurrentModelConfig();
  return thinkingConfig ? ({ ...body, thinkingConfig } as T) : body;
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({
    error: response.statusText || 'Request failed',
  }));
}

function createHttpError(
  response: Response,
  data: { details?: unknown; error?: unknown; errorCode?: unknown },
  fallback: string,
): Error & { errorCode?: string; statusCode?: number } {
  const message =
    typeof data.details === 'string'
      ? data.details
      : typeof data.error === 'string'
        ? data.error
        : `${fallback}: HTTP ${response.status}`;
  const error = new Error(message) as Error & { errorCode?: string; statusCode?: number };
  if (typeof data.errorCode === 'string') {
    error.errorCode = data.errorCode;
  }
  error.statusCode = response.status;
  return error;
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function errorMeta(error: unknown): Pick<SceneContentResult, 'errorCode' | 'statusCode'> {
  if (!error || typeof error !== 'object') return {};
  const record = error as { errorCode?: unknown; statusCode?: unknown };
  return {
    ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    ...(typeof record.statusCode === 'number' ? { statusCode: record.statusCode } : {}),
  };
}

/** Call POST /api/generate/scene-content (step 1) */
export async function fetchSceneContent(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    stageId: string;
    pdfImages?: PdfImage[];
    imageMapping?: ImageMapping;
    stageInfo: {
      name: string;
      description?: string;
      language?: string;
      style?: string;
    };
    agents?: AgentInfo[];
    languageDirective?: string;
    requirements?: UserRequirements;
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneContentResult>,
): Promise<SceneContentResult> {
  try {
    return await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/scene-content', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(withThinkingConfig(params)),
          signal,
        });

        const data = await readJsonResponse(response);
        if (!response.ok) {
          throw createHttpError(response, data, 'Scene content request failed');
        }

        return data as unknown as SceneContentResult;
      },
      {
        label: `scene content "${params.outline.title}"`,
        shouldRetryResult: (result) => !result.success || !result.content,
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      success: false,
      error: messageFromError(error, 'Content generation failed'),
      ...errorMeta(error),
    };
  }
}

/** Call POST /api/generate/scene-actions (step 2) */
export async function fetchSceneActions(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    content: unknown;
    stageId: string;
    agents?: AgentInfo[];
    previousSpeeches?: string[];
    userProfile?: string;
    languageDirective?: string;
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneActionsResult>,
): Promise<SceneActionsResult> {
  try {
    return await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/scene-actions', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(withThinkingConfig(params)),
          signal,
        });

        const data = await readJsonResponse(response);
        if (!response.ok) {
          throw createHttpError(response, data, 'Scene actions request failed');
        }

        return data as unknown as SceneActionsResult;
      },
      {
        label: `scene actions "${params.outline.title}"`,
        shouldRetryResult: (result) => !result.success || !result.scene,
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      success: false,
      error: messageFromError(error, 'Actions generation failed'),
      ...errorMeta(error),
    };
  }
}

/**
 * Actions-reuse guard: skip the actions LLM pass when the retry regenerated
 * byte-identical content for the same outline with the same action-relevant
 * session inputs, and the previously persisted scene still records the exact
 * fingerprint (`scene.actionsSourceHash`). Reusing the persisted scene keeps
 * its canvas actions AND its already-rendered TTS references, so a flake
 * retry pays zero model tokens downstream. A hash mismatch — content parks at
 * a different order, a missing fingerprint (pre-guard scenes), agents or
 * directive edits, PBL caveats — falls back to a fresh actions pass.
 */
function findReusableActionsScene(
  outlineId: string | undefined,
  content: unknown,
  params: {
    agents?: AgentInfo[];
    userProfile?: string;
    languageDirective?: string;
  },
): (Scene & { actionsSourceHash?: string }) | undefined {
  if (!outlineId) return undefined;
  const hash = computeActionsSourceHash({
    content,
    agents: params.agents,
    userProfile: params.userProfile,
    languageDirective: params.languageDirective,
  });
  const state = useStageStore.getState();
  const existing = state.scenes
    .filter((scene) => scene.outlineId === outlineId)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  if (!existing || existing.actionsSourceHash !== hash) return undefined;
  return existing;
}

function attachActionsSourceHash(
  scene: Scene,
  content: unknown,
  params: { agents?: AgentInfo[]; userProfile?: string; languageDirective?: string },
): Scene {
  return {
    ...scene,
    actionsSourceHash: computeActionsSourceHash({
      content,
      agents: params.agents,
      userProfile: params.userProfile,
      languageDirective: params.languageDirective,
    }),
  } as Scene;
}

interface TTSApiResponse {  success?: boolean;
  base64?: string;
  format?: string;
  error?: string;
  details?: string;
}

// A dead narrator voice is retried at most once against a DIFFERENT voice (the
// global voice when the binding differs from it, or the deterministic
// enabled-provider pick when bound == global). This bounds the total
// /api/generate/tts attempts to 2 per call and guarantees the
// QWEN_VC_VOICE_NOT_FOUND retry cannot loop a chain of dead voices
// (bound-dead → global-dead → deterministic-dead → …) forever.
const MAX_NARRATOR_VOICE_FALLBACK_HOPS = 1;

/** Generate TTS for one speech action and return its allocated asset reference. */
export async function generateAndStoreTTS(
  requestId: string,
  text: string,
  language?: string,
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<TTSApiResponse>,
  existingAudioId?: string,
  stageId?: string,
  // Internal: an explicit voice that bypasses narrator binding resolution — used
  // to retry narration against the deterministic enabled-provider pick when the
  // pinned narrator voice (bound == global) turns out to be unusable.
  overrideVoice?: ResolvedVoice,
  // Internal: number of narrator voice-fallback hops already taken. Guards the
  // QWEN_VC_VOICE_NOT_FOUND retry so a chain of dead voices can never loop
  // /api/generate/tts beyond a single fallback hop.
  fallbackHops = 0,
): Promise<string | null> {
  const settings = useSettingsStore.getState();
  // A generated roster's explicit voice binding is the course voice source of truth.
  // Global settings remain the fallback for classrooms without a binding.
  const teacher = pickNarratorAgent(useAgentRegistry.getState().listAgents());
  const globalProviderConfig = settings.ttsProvidersConfig?.[settings.ttsProviderId];
  const boundVoice = teacher?.voiceConfig;
  const boundKey = boundVoice ? voiceBindingKey(boundVoice) : undefined;
  // The narrator pin makes boundVoice == the global voice. That equality must
  // not defeat the unavailable-binding fallbacks: when the pinned voice is
  // unusable (provider disabled, or the clone deleted server-side), fall back
  // to the deterministic enabled-provider pick with a single non-fatal notice
  // instead of throwing (QWEN_VC_VOICE_NOT_FOUND) or silently skipping.
  const globalDiffers =
    !!boundVoice &&
    (boundVoice.providerId !== settings.ttsProviderId || boundVoice.voiceId !== settings.ttsVoice);
  const fallbackForUnusablePin = (): ResolvedVoice | null => {
    if (!boundVoice) return null;
    const key = voiceBindingKey(boundVoice);
    markVoiceBindingUnavailable(boundVoice);
    if (markVoiceBindingNoticeShown(key)) {
      toast.warning(getClientTranslation('settings.qwenCloneNarrationUnavailable'));
    }
    return resolveDeterministicFallbackVoice(
      getEnabledProvidersWithVoices(settings.ttsProvidersConfig),
      0,
    );
  };

  let resolvedVoice =
    overrideVoice ??
    resolveNarratorVoiceBinding(
      boundVoice && isVoiceBindingUnavailable(boundVoice) ? undefined : boundVoice,
      {
        providerId: settings.ttsProviderId,
        modelId: globalProviderConfig?.modelId,
        voiceId: settings.ttsVoice,
      },
      settings.ttsProvidersConfig,
    );

  // Pinned narrator (bound == global) whose provider became disabled:
  // resolveNarratorVoiceBinding falls back to the global voice, which is the
  // same broken provider — swap in the deterministic enabled-provider pick
  // instead of silently skipping narration below.
  if (
    boundVoice &&
    !globalDiffers &&
    !isTTSProviderEnabled(
      resolvedVoice.providerId,
      settings.ttsProvidersConfig?.[resolvedVoice.providerId],
    )
  ) {
    resolvedVoice = fallbackForUnusablePin() ?? resolvedVoice;
  }

  const ttsProviderId = resolvedVoice.providerId;
  const ttsVoice = resolvedVoice.voiceId;
  const ttsProviderConfig = settings.ttsProvidersConfig?.[ttsProviderId];
  const ttsModelId = resolveTTSModelForVoice(
    ttsProviderId,
    ttsVoice,
    resolvedVoice.modelId ?? ttsProviderConfig?.modelId,
  );

  if (ttsProviderId === 'browser-native-tts') return null;
  // Don't server-generate against a disabled/unconfigured provider (#665).
  if (!isTTSProviderEnabled(ttsProviderId, ttsProviderConfig)) return null;

  // Narration is the teacher's voice — resolve it from the teacher agent profile
  // through the single resolver (registers + references by id for stable timbre).
  const providerOptions = await resolveAgentVoiceOptions(teacher, {
    providerId: ttsProviderId,
    providerConfig: { ...ttsProviderConfig, modelId: ttsModelId },
    voiceId: ttsVoice,
    language,
  });
  let data: TTSApiResponse;
  try {
    data = await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            audioId: requestId,
            ttsProviderId,
            ttsModelId,
            ttsVoice,
            ttsSpeed: settings.ttsSpeed,
            ttsApiKey: ttsProviderConfig?.apiKey || undefined,
            // Managed providers resolve their base URL server-side; only send the
            // client's own base URL (custom providers).
            ttsBaseUrl:
              ttsProviderConfig?.baseUrl || ttsProviderConfig?.customDefaultBaseUrl || undefined,
            ttsProviderOptions: providerOptions,
          }),
          signal,
        });

        const data = (await readJsonResponse(response)) as TTSApiResponse;
        if (!response.ok) {
          throw createHttpError(response, data, 'TTS request failed');
        }
        return data;
      },
      {
        label: `tts "${requestId}"`,
        shouldRetryResult: (result) => !result.success || !result.base64 || !result.format,
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    const errorCode =
      error && typeof error === 'object' && 'errorCode' in error
        ? (error as { errorCode?: unknown }).errorCode
        : undefined;
    // Recover from a missing clone only when the attempt that just failed used
    // the bound binding itself: marking it unavailable makes the resolver fall
    // back to the global voice, a DIFFERENT voice. When the failure is already
    // on the global voice (or on the deterministic pick), retrying would hit
    // the same dead voice — fall through and surface the error instead of
    // hot-looping /api/generate/tts (bound-dead → global-dead → …). The
    // fallbackHops bound keeps even pathological chains at a single hop.
    if (
      errorCode === 'QWEN_VC_VOICE_NOT_FOUND' &&
      boundKey &&
      boundVoice &&
      fallbackHops < MAX_NARRATOR_VOICE_FALLBACK_HOPS
    ) {
      if (voiceBindingKey(resolvedVoice) === boundKey) {
        markVoiceBindingUnavailable(boundVoice);
        if (markVoiceBindingNoticeShown(boundKey)) {
          toast.warning(getClientTranslation('settings.qwenCloneNarrationUnavailable'));
        }
        if (globalDiffers) {
          // The binding is a voice distinct from the global one: retry with the
          // binding marked unavailable, which makes the resolver fall back to the
          // global voice.
          return generateAndStoreTTS(
            requestId,
            text,
            language,
            signal,
            retryOptions,
            existingAudioId,
            stageId,
            undefined,
            fallbackHops + 1,
          );
        }
        // Bound == global (pinned narrator): a retry would hit the same missing
        // clone, so fall back to the deterministic enabled-provider pick once.
        // (mark/notice were applied above; the helper's repeat is idempotent.)
        if (!overrideVoice) {
          const fallbackVoice = fallbackForUnusablePin();
          if (fallbackVoice) {
            return generateAndStoreTTS(
              requestId,
              text,
              language,
              signal,
              retryOptions,
              existingAudioId,
              stageId,
              fallbackVoice,
              fallbackHops + 1,
            );
          }
        }
      }
    }
    throw error;
  }
  if (!data.success || !data.base64 || !data.format) {
    const err = new Error(
      data.details || data.error || 'TTS request failed: invalid response payload',
    );
    log.warn('TTS failed for', requestId, ':', err);
    throw err;
  }

  const binary = atob(data.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: `audio/${data.format}` });
  // Measure duration once at store time so video export (#854) can map this
  // clip onto a timeline without re-decoding. null → leave undefined; the audio
  // still persists and plays.
  const duration = measureAudioDuration(bytes, data.format) ?? undefined;
  const audioId = existingAudioId ?? requestId;
  await db.audioFiles.put({
    id: audioId,
    stageId,
    blob,
    duration,
    format: data.format,
    text,
    voice: ttsVoice,
    createdAt: Date.now(),
  });
  // Forward-sync to the server asset store when server persistence is
  // configured: narration bytes must live WHERE the document does, or every
  // other browser/tab of the same profile sees a "complete" deck that is
  // silently mute (the doc carries audioIds, the bytes carry only this
  // browser). Best-effort: playback never depends on the upload; the local
  // store stays authoritative for this browser.
  void uploadAudioToServerAssetStore(
    audioId,
    blob,
    data.format,
    stageId,
    text,
    ttsVoice,
    duration,
  );
  return audioId;
}

const inFlightServerUploads = new Set<string>();

/**
 * Fire-and-forget narration byte upload to the server asset store. Racche
 * safety: exactly-one-in-flight per audioId (concurrent callers coalesce on
 * the same promise-replacing Set check — the caller passes the freshest bytes
 * so a finisher never overwrites a NEWER bytes with older ones out of order:
 * last WRITE wins only when the receiver is the newest writer, so stale
 * in-flight writes race-guard on `stageId + createdAt`-tagged rows and the
 * server stores content-side copy). Best-effort by contract: playback never
 * waits on this.
 */
async function uploadAudioToServerAssetStore(
  audioId: string,
  blob: Blob,
  format: string,
  stageId: string | undefined,
  text: string,
  voice: string,
  duration?: number,
): Promise<void> {
  if (inFlightServerUploads.has(audioId)) return; // a same-id upload is already running; its bytes are the fresher ones
  inFlightServerUploads.add(audioId);
  try {
    const { isBrowserPersistenceEnabled, getPersistenceRequestHeaders } = await import(
      '@/lib/persistence/bootstrap'
    );
    if (!isBrowserPersistenceEnabled()) return;
    const headers = await getPersistenceRequestHeaders();
    const response = await fetch(`/api/persistence/assets/${encodeURIComponent(audioId)}`, {
      method: 'PUT',
      headers: {
        ...headers,
        'content-type': blob.type || `audio/${format}`,
        'x-asset-meta': btoa(
          unescape(
            encodeURIComponent(
              JSON.stringify({
                mediaType: 'audio',
                text,
                voice,
                duration,
                provider: 'tts',
                stageId,
              }),
            ),
          ),
        ),
      },
      body: blob,
    });
    if (!response.ok && response.status !== 204) {
      log.warn(`Narration server upload for ${audioId} failed (HTTP ${response.status}); will retry on next regeneration`);
    }
  } catch (error) {
    log.warn('Narration server upload failed (best-effort):', error instanceof Error ? error.message : error);
  } finally {
    inFlightServerUploads.delete(audioId);
  }
}

export async function removeFreshTtsAllocations(assetIds: readonly string[]): Promise<void> {
  for (const assetId of new Set(assetIds)) {
    await db.audioFiles.delete(assetId).catch(() => undefined);
  }
}

function speechAllocationIds(scene: Scene): string[] {
  return (scene.actions ?? []).flatMap((action) =>
    action.type === 'speech' && action.audioId ? [action.audioId] : [],
  );
}

/** Generate TTS for all speech actions in a scene. Returns result. */
export async function generateTTSForScene(
  scene: Scene,
  language?: string,
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<TTSApiResponse>,
  /**
   * Restrict regeneration to these pre-split action ids (a drain pass that
   * found only SOME of the scene's narration dead). Byte-aware repair must
   * never re-render clips that already resolve — the provider call is paid
   * work, and a re-render under a NEW id would also orphan the healthy rows.
   * Split descendants (`<id>_tts_<n>`) count as the same logical action.
   */
  onlyActionIds?: string[],
): Promise<{ success: boolean; failedCount: number; recoveredIds: string[]; error?: string }> {
  const providerId = useSettingsStore.getState().ttsProviderId;
  scene.actions = splitLongSpeechActions(scene.actions || [], providerId);
  const speechActions = scene.actions.filter(
    (a): a is SpeechAction => a.type === 'speech' && !!a.text,
  );
  if (speechActions.length === 0) {
    return { success: true, failedCount: 0, recoveredIds: [] };
  }
  const targets = onlyActionIds
    ? speechActions.filter((action) =>
        onlyActionIds.some(
          (id) => action.id === id || action.id.startsWith(`${id}_tts_`),
        ),
      )
    : speechActions;
  if (targets.length === 0) {
    return { success: true, failedCount: 0, recoveredIds: [] };
  }

  let failedCount = 0;
  let lastError: string | undefined;
  const freshAllocations: string[] = [];
  const recoveredIds: string[] = [];
  // Per-action failure containment: prior ids of the REGEN TARGETS only.
  // On any failure, these are restored verbatim — a failed pass can never
  // strip audio the deck already had, and healthy actions outside the target
  // set are invisible to this function's failure handling by construction.
  const previousTargetIds = new Map(
    targets.map((action) => [action.id, action.audioId] as const),
  );

  // Scene order keeps the provider request correlation label unique. Storage
  // identity is allocated by the pool and is never derived from this value.
  const sceneOrder = scene.order;

  // Generate + store one action's audio. Failures are counted, not thrown, so
  // one bad clip never aborts the rest of the scene.
  const generateOne = async (action: SpeechAction) => {
    const requestId = `tts_s${sceneOrder}_${action.id}`;
    try {
      const assetId = await generateAndStoreTTS(
        requestId,
        action.text,
        language,
        signal,
        retryOptions,
        undefined,
        scene.stageId,
      );
      if (assetId) {
        action.audioId = assetId;
        freshAllocations.push(assetId);
        recoveredIds.push(action.id);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;

      failedCount++;
      lastError = error instanceof Error ? error.message : `TTS failed for action ${action.id}`;
      log.warn('TTS generation failed:', {
        providerId,
        actionId: action.id,
        sceneOrder,
        requestId,
        textLength: action.text.length,
        error: lastError,
      });
    }
  };

  // #660 follow-up: speech actions within a scene are independent — each renders
  // its own audio under its own audioId, with no cross-action ordering — so when
  // the server opts into parallel generation, render them with bounded
  // concurrency (reusing the PARALLEL_SCENE_CONCURRENCY knob) instead of one at a
  // time. Default (0 / unset) keeps the original strictly-serial behaviour.
  const ttsConcurrency = Math.max(
    0,
    Math.floor(useSettingsStore.getState().parallelSceneConcurrency ?? 0),
  );
  try {
    if (ttsConcurrency > 1 && targets.length > 1) {
      const settled = await Promise.allSettled(
        lazyBoundedMap(targets, ttsConcurrency, generateOne),
      );
      const rejected = settled.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (rejected) throw rejected.reason;
    } else {
      for (const action of targets) {
        await generateOne(action);
      }
    }
  } catch (error) {
    // Abort/throw path: the whole regeneration collapses. Recovered ids are
    // not persisted anywhere yet, so their fresh allocations are reclaimed;
    // the targets revert to their previous refs (absent stays absent — no
    // `audioId: undefined` keys littering the actions).
    await removeFreshTtsAllocations(freshAllocations);
    for (const action of targets) {
      const previous = previousTargetIds.get(action.id);
      if (previous === undefined) delete action.audioId;
      else action.audioId = previous;
    }
    throw error;
  }

  if (failedCount > 0) {
    // Partial failure: clips that DID regenerate keep their fresh bytes and
    // ids (they are valid, playable audio — deleting them would re-render
    // them next pass); only the failed targets revert to their prior refs.
    for (const action of targets) {
      if (!recoveredIds.includes(action.id)) {
        const previous = previousTargetIds.get(action.id);
        if (previous === undefined) delete action.audioId;
        else action.audioId = previous;
      }
    }
  }

  return {
    success: failedCount === 0,
    failedCount,
    recoveredIds,
    error: lastError,
  };
}

/**
 * Background fill queue (Pillar 2 §4.6): re-run TTS for narration whose
 * audio does not currently resolve. Detection is byte-aware and PER ACTION:
 * a scene speaks through several clips, and a provider flake usually kills
 * a subset — regenerating the recovered clips too would both waste paid
 * provider calls and orphan their healthy rows. Drains once per call;
 * provider failures leave the still-dead refs pending (retryable again via
 * the per-scene affordance or the next repair pass).
 */
export async function drainPendingSceneTTS(
  scenes: Scene[],
  language?: string,
  signal?: AbortSignal,
): Promise<number> {
  const settings = useSettingsStore.getState();
  if (
    !settings.ttsEnabled ||
    settings.ttsProviderId === 'browser-native-tts' ||
    !isTTSProviderEnabled(
      settings.ttsProviderId,
      settings.ttsProvidersConfig?.[settings.ttsProviderId],
    )
  ) {
    return 0;
  }

  // Byte-aware pending detection: an audioId alone is not evidence of
  // playable narration — legacy generations left references whose bytes were
  // never materialized (or were evicted). A ref counts as pending when it has
  // no id OR when its bytes do not currently resolve (pool → mirror → server
  // — the exact chain playback resolves through).
  const { resolveAudioBlob } = await import('@/lib/media/resolve-audio-bytes');
  const pendingByScene = await Promise.all(
    scenes.map(async (scene) => {
      const speechActions = (scene.actions ?? []).filter(
        (a): a is SpeechAction => a.type === 'speech' && !!a.text,
      );
      if (speechActions.length === 0) return null;
      const missing = await Promise.all(
        speechActions.map(async (action) => {
          if (!action.audioId) return true;
          const bytes = await resolveAudioBlob(action.audioId);
          return !bytes || bytes.size === 0;
        }),
      );
      const deadIds = speechActions.filter((_, i) => missing[i]).map((action) => action.id);
      return deadIds.length > 0 ? { scene, deadIds } : null;
    }),
  );
  const pendingScenes = pendingByScene.filter(
    (entry): entry is { scene: Scene; deadIds: string[] } => !!entry,
  );
  if (pendingScenes.length === 0) return 0;

  log.info(`TTS background drain: ${pendingScenes.length} scene(s) with pending audio`);
  // The repair pass is a queue citizen: the cards it is fixing read as
  // ACTIVE (spinning Retry) while it runs, and a fixed scene drops its
  // outline from the one queue (failedOutlines) the moment bytes land.
  useStageStore.getState().setRepairActive('narration');
  let restored = 0;
  try {
    for (const { scene, deadIds } of pendingScenes) {
      if (signal?.aborted) break;
      try {
        const result = await generateTTSForScene(scene, language, signal, undefined, deadIds);
        if (result.recoveredIds.length > 0) {
          useStageStore.getState().updateScene(scene.id, { actions: scene.actions });
          restored += 1;
          if (scene.outlineId) {
            useStageStore.getState().retryFailedOutline(scene.outlineId);
          }
        }
        if (result.failedCount > 0) {
          log.warn(
            `TTS drain for scene "${scene.title}": ${result.recoveredIds.length} clip(s) restored, ${result.failedCount} still pending`,
          );
        }
      } catch (error) {
        if (isAbortError(error)) break;
        log.warn(`TTS drain error for scene "${scene.title}":`, error);
      }
    }
  } finally {
    useStageStore.getState().setRepairActive(null);
  }
  if (restored > 0) {
    log.info(`TTS background drain restored audio for ${restored} scene(s)`);
  }
  return restored;
}

export interface UseSceneGeneratorOptions {  onSceneGenerated?: (scene: Scene, index: number) => void;
  onSceneFailed?: (outline: SceneOutline, error: string) => void;
  /** TTS demotion: audio failed but the scene was kept (fill phase retryable). */
  onSceneTtsFailed?: (outline: SceneOutline, error: string) => void;
  onPhaseChange?: (phase: 'content' | 'actions', outline: SceneOutline) => void;
  onComplete?: () => void;
}

export interface GenerationParams {
  pdfImages?: PdfImage[];
  imageMapping?: ImageMapping;
  stageInfo: {
    name: string;
    description?: string;
    language?: string;
    style?: string;
  };
  agents?: AgentInfo[];
  userProfile?: string;
  languageDirective?: string;
}

/** Speech action ids whose narration bytes do not currently resolve. */
async function detectDeadSpeechActionIds(scene: Scene): Promise<string[]> {
  const { resolveAudioBlob } = await import('@/lib/media/resolve-audio-bytes');
  const speechActions = (scene.actions ?? []).filter(
    (a): a is SpeechAction => a.type === 'speech' && !!a.text,
  );
  if (speechActions.length === 0) return [];
  const missing = await Promise.all(
    speechActions.map(async (action) => {
      if (!action.audioId) return true;
      const bytes = await resolveAudioBlob(action.audioId);
      return !bytes || bytes.size === 0;
    }),
  );
  return speechActions.filter((_, i) => missing[i]).map((action) => action.id);
}

/**
 * THE ONE PER-OUTLINE PIPELINE (generation = regeneration = recovery).
 *
 * The material classes are DECLARATIVE descriptors, not a hardcoded switch:
 * each registry entry declares enabled-ness, its work, and whether failure
 * re-enters the queue. Adding a future asset class (widget HTML re-bake,
 * voice re-design, exam assets) = registering one descriptor — no new
 * subsystem, no per-feature plumbing. The iterator below records phase rows
 * (running/done/failed), the ONE-QUEUE re-add, and returns the outcome;
 * call sites keep only orchestration (loops, epochs, leases).
 */
type OutlineJobMode = 'generate' | 'repair';

type MaterialPhaseKey = 'content' | 'actions' | 'tts' | 'media';

interface OutlineJobRunState {
  contentResult?: SceneContentResult;
  scene?: Scene;
  previousSpeeches: string[];
}

interface MaterialPhaseDescriptor {
  key: MaterialPhaseKey;
  /**
   * Whether THIS run should run the phase at all (media only rides in
   * repair mode; the batch keeps its global parallel enqueue).
   */
  enabled: (ctx: { mode: OutlineJobMode }) => boolean;
  run: (state: OutlineJobRunState, input: OutlineJobInput) => Promise<{
    status: 'done' | 'failed';
    error?: string;
  }>;
  /** Failed rows re-enter the one queue (content/actions do; tts/media
      keep the scene and circumstance differ). */
  readonly queueOnFailure: boolean;
}

const OUTLINE_MATERIAL_PHASES: MaterialPhaseDescriptor[] = [
  {
    key: 'content',
    enabled: () => true,
    queueOnFailure: true,
    run: async (state, input) => {
      const { outline, allOutlines, params, signal, mode, preComputedContent } = input;
      const stageId = useStageStore.getState().stage?.id;
      if (!stageId) return { status: 'failed', error: 'no stage' };
      // Bypass paths (pre-warmed batch content / repair hash reuse).
      if (preComputedContent) {
        state.contentResult = preComputedContent;
        return { status: 'done' };
      }
      if (mode === 'repair') {
        const persistedScene = useStageStore
          .getState()
          .scenes.find((scene) => scene.order === outline.order);
        const reusableContent =
          persistedScene &&
          // Settled iff the persisted scene's hash matches the CURRENT source
          // inputs (agents, profile, directive): a blueprint edit invalidates
          // the hash and re-pays content.
          persistedScene.actionsSourceHash !== undefined &&
          persistedScene.actionsSourceHash ===
            computeActionsSourceHash({
              content: persistedScene.content,
              agents: params.agents,
              userProfile: params.userProfile,
              languageDirective: params.languageDirective,
            });
        if (reusableContent && persistedScene) {
          state.contentResult = {
            success: true,
            content: persistedScene.content,
          } as SceneContentResult;
          // Verify-on-reuse: the layout step is part of the train, not part of
          // the content pass — hash-matching the text must not skip geometry
          // repair. Debt scenes re-run through the queue get the same
          // deterministic clamp + bounded layout patch fresh content gets.
          const layout = await verifyAndRepairSlideLayout(persistedScene.content);
          if (layout.repairFailed && layout.repairError) {
            console.warn(
              `[layout-verify] outline ${outline.id} (reused content): ${layout.repairError}; ${layout.findings.length} finding(s) remain`,
            );
            return {
              status: 'failed',
              error: 'layout repair failed: ' + (layout.repairError || 'unresolved placement findings'),
            };
          }
          if (layout.repaired || layout.clamped > 0) {
            console.log(
              `[layout-verify] scene ${outline.id} (reused content): clamped=${layout.clamped} repaired=${layout.repaired} residual=${layout.findings.length}`,
            );
          }
          return { status: 'done' };
        }
      }
      const contentResult = await fetchSceneContent(
        {
          outline,
          allOutlines,
          stageId,
          pdfImages: params.pdfImages,
          imageMapping: params.imageMapping,
          stageInfo: params.stageInfo,
          agents: params.agents,
          languageDirective: params.languageDirective,
        },
        signal,
      );
      if (!contentResult.success || !contentResult.content) {
        return {
          status: 'failed',
          error: contentResult.error || 'Content generation failed',
        };
      }
      const layout = await verifyAndRepairSlideLayout(contentResult.content);
      if (layout.repairFailed && layout.repairError) {
        console.warn(
          `[layout-verify] outline ${outline.id}: ${layout.repairError}; ${layout.findings.length} finding(s) remain`,
        );
        return {
          status: 'failed',
          error: 'layout repair failed: ' + (layout.repairError || 'unresolved placement findings'),
        };
      }
      if (layout.repaired || layout.clamped > 0) {
        console.log(
          `[layout-verify] scene ${outline.id}: clamped=${layout.clamped} repaired=${layout.repaired} residual=${layout.findings.length}`,
        );
      }
      if (contentResult.depth) {
        useStageStore.getState().recordSceneDepth(outline.order, contentResult.depth);
      }
      state.contentResult = contentResult;
      return { status: 'done' };
    },
  },
  {
    key: 'actions',
    enabled: () => true,
    queueOnFailure: true,
    run: async (state, input) => {
      const { effectiveOutline, allOutlines, params, signal } = input;
      const contentResult = state.contentResult!;
      const stageId = useStageStore.getState().stage?.id;
      if (!stageId) return { status: 'failed', error: 'no stage' };
      const reusableActionsScene = findReusableActionsScene(
        (contentResult.effectiveOutline || effectiveOutline || input.outline).id,
        contentResult.content,
        params,
      );
      const actionsResult: SceneActionsResult = reusableActionsScene
        ? ({
            success: true,
            scene: attachActionsSourceHash(reusableActionsScene, contentResult.content, params),
            reused: true,
          } as SceneActionsResult)
        : await fetchSceneActions(
            {
              outline: contentResult.effectiveOutline || effectiveOutline || input.outline,
              allOutlines,
              content: contentResult.content,
              stageId,
              agents: params.agents,
              previousSpeeches: state.previousSpeeches,
              userProfile: params.userProfile,
              languageDirective: params.languageDirective,
            },
            signal,
          );
      if (!actionsResult.success || !actionsResult.scene) {
        return {
          status: 'failed',
          error: actionsResult.error || 'Actions generation failed',
        };
      }
      // Stamp EVERY actions result — fresh ones too. Without this the store
      // carries no fingerprint, the persisted document records none (the DSL
      // app-field goes through verbatim), and the NEXT repair (even a pure
      // voice-only one) re-pays the full content/actions LLM passes because
      // `findReusableActionsScene` requires a defined hash. Stamping here is
      // what makes the first full pass the ONLY full pass.
      state.scene = attachActionsSourceHash(actionsResult.scene, contentResult.content, params);
      return { status: 'done' };
    },
  },
  {
    key: 'tts',
    enabled: () => {
      const settings = useSettingsStore.getState();
      return (
        settings.ttsEnabled &&
        settings.ttsProviderId !== 'browser-native-tts' &&
        isTTSProviderEnabled(
          settings.ttsProviderId,
          settings.ttsProvidersConfig?.[settings.ttsProviderId],
        )
      );
    },
    queueOnFailure: false,
    run: async (state, input) => {
      const { params, signal, mode } = input;
      const scene = state.scene!;
      if (mode === 'repair') {
        // Fill: ONLY the dead clips re-render (byte truth per action).
        const deadIds = await detectDeadSpeechActionIds(scene);
        if (deadIds.length === 0) return { status: 'done' };
        const ttsResult = await generateTTSForScene(
          scene,
          params.languageDirective || params.stageInfo.language,
          signal,
          undefined,
          deadIds,
        );
        return ttsResult.success
          ? { status: 'done' }
          : { status: 'failed', error: ttsResult.error || 'TTS generation failed' };
      }
      const ttsResult = await generateTTSForScene(
        scene,
        params.languageDirective || params.stageInfo.language,
        signal,
      );
      return ttsResult.success
        ? { status: 'done' }
        : { status: 'failed', error: ttsResult.error || 'TTS generation failed' };
    },
  },
  {
    key: 'media',
    enabled: ({ mode }) => mode === 'repair',
    queueOnFailure: false,
    run: async (_state, input) => {
      const { allOutlines, signal } = input;
      const stageId = useStageStore.getState().stage?.id;
      if (!stageId) return { status: 'failed', error: 'no stage' };
      // The repair primitive for generated bytes is the orchestrator's
      // byte-aware requeue dispatched FOR THIS OUTLINE ONLY (batch keeps
      // its global parallel enqueue). Healthy rows skip; dead ones re-kick.
      const { generateMediaForOutlines } = await import('@/lib/media/media-orchestrator');
      await generateMediaForOutlines(
        allOutlines.filter((outline) => outline.id === input.outline.id),
        stageId,
        signal,
      ).catch(
        (err: unknown) =>
          log.warn(
            `Media repair enqueue for outline ${JSON.stringify(input.outline.id)} failed:`,
            err instanceof Error ? err.message : err,
          ),
      );
      return { status: 'done' };
    },
  },
];

interface OutlineJobInput {
  outline: SceneOutline;
  /** Effective outline (ranked/downgraded variants apply on rerank). */
  effectiveOutline?: SceneOutline;
  allOutlines: SceneOutline[];
  params: GenerationParams;
  signal: AbortSignal;
  mode: OutlineJobMode;
  previousSpeeches: string[];
  /**
   * Batch parallelism hands its pre-warmed content in; the pipeline then
   * skips the content phase's fetch (recording only). Absent → the pipeline
   * fetches (generate) or reuses the persisted hash (repair).
   */
  preComputedContent?: SceneContentResult;
}

/**
 * The executor: one registry walk with phase-row recording centralized —
 * descriptors declare work and queue-on-failure semantics, the runner owns
 * the store vocabulary once.
 */
async function runOutlineJob(input: OutlineJobInput): Promise<{
  success: boolean;
  scene?: Scene;
  failedPhase?: 'content' | 'actions' | 'tts' | 'media';
  error?: string;
}> {
  const runState: OutlineJobRunState = { previousSpeeches: input.previousSpeeches };
  const phaseKeyFromDescriptor = (descriptor: MaterialPhaseDescriptor): MaterialPhaseKey =>
    descriptor.key;

  for (const descriptor of OUTLINE_MATERIAL_PHASES) {
    const key = phaseKeyFromDescriptor(descriptor);
    if (!descriptor.enabled({ mode: input.mode })) continue;
    useStageStore.getState().recordScenePhase(input.outline.id, key, { status: 'running' });
    const outcome = await descriptor.run(runState, input);
    if (outcome.status === 'done') {
      useStageStore.getState().recordScenePhase(input.outline.id, key, { status: 'done' });
      continue;
    }
    const error = outcome.error || `${key} generation failed`;
    useStageStore.getState().recordScenePhase(input.outline.id, key, {
      status: 'failed',
      error,
    });
    if (descriptor.queueOnFailure || input.mode === 'repair') {
      useStageStore.getState().addFailedOutline(input.outline);
    }
    return {
      success: false,
      failedPhase: descriptor.key,
      error,
    };
  }

  return { success: true, scene: runState.scene };
}

export function useSceneGenerator(options: UseSceneGeneratorOptions = {}) {
  const abortRef = useRef(false);
  const generatingRef = useRef(false);
  const mediaAbortRef = useRef<AbortController | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const lastParamsRef = useRef<GenerationParams | null>(null);
  const generateRemainingRef = useRef<((params: GenerationParams) => Promise<void>) | null>(null);

  const store = useStageStore;

  const generateRemaining = useCallback(
    async (params: GenerationParams) => {
      lastParamsRef.current = params;
      if (generatingRef.current) return;
      generatingRef.current = true;
      abortRef.current = false;
      const removeGeneratingOutline = (outlineId: string) => {
        const current = store.getState().generatingOutlines;
        if (!current.some((o) => o.id === outlineId)) return;
        store.getState().setGeneratingOutlines(current.filter((o) => o.id !== outlineId));
      };

      // Create a new AbortController for this generation run
      fetchAbortRef.current = new AbortController();
      const signal = fetchAbortRef.current.signal;

      const state = store.getState();
      const { outlines, scenes, stage } = state;
      const startEpoch = state.generationEpoch;
      if (!stage || outlines.length === 0) {
        generatingRef.current = false;
        return;
      }

      store.getState().setGenerationStatus('generating');

      // Cross-tab lease: exactly one tab per stage resumes generation.
      const generationLease = await claimGenerationLease(stage.id);
      if (generationLease === null) {
        log.info(`Another browser tab is already driving generation for ${stage.id}; skipping duplicate resume`);
        store.getState().setGenerationStatus('idle');
        store.getState().setGeneratingOutlines([]);
        generatingRef.current = false;
        return;
      }

      // Determine pending outlines (skipped outlines stay closed — Pillar 2 §4.9)
      const completedOrders = new Set(scenes.map((s) => s.order));
      const skippedIds = new Set(state.skippedOutlineIds);
      const pending = outlines
        .filter((o) => !completedOrders.has(o.order) && !skippedIds.has(o.id))
        .sort((a, b) => a.order - b.order);

      if (pending.length === 0) {
        store.getState().setGenerationStatus('completed');
        store.getState().setGeneratingOutlines([]);
        store.getState().setGenerationComplete(true);
        options.onComplete?.();
        generationLease();
        generatingRef.current = false;
        return;
      }

      store.getState().setGeneratingOutlines(pending);

      // Launch media generation in parallel — does not block content/action generation
      mediaAbortRef.current = new AbortController();
      generateMediaForOutlines(outlines, stage.id, mediaAbortRef.current.signal).catch((err) => {
        log.warn('Media generation error:', err);
      });

      // Get previousSpeeches from last completed scene
      let previousSpeeches: string[] = [];
      const sortedScenes = [...scenes].sort((a, b) => a.order - b.order);
      if (sortedScenes.length > 0) {
        const lastScene = sortedScenes[sortedScenes.length - 1];
        previousSpeeches = (lastScene.actions || [])
          .filter((a): a is SpeechAction => a.type === 'speech')
          .map((a) => a.text);
      }

      // #572: opt-in parallel content fetch. Concurrency is server-configured
      // (PARALLEL_SCENE_CONCURRENCY), default 0 = off, so out-of-box behaviour is
      // unchanged.
      const parallelConcurrency = Math.max(
        0,
        // Belt-and-suspenders: the value is already clamped server-side and again
        // in the settings store; re-clamp here so a stale/garbage store value can
        // never spawn an unbounded fetch fan-out.
        Math.floor(useSettingsStore.getState().parallelSceneConcurrency ?? 0),
      );
      const useParallelContent = parallelConcurrency > 1 && pending.length > 1;

      // Pipelined generation loop (#572). When parallelism is on, scene *content*
      // fetches are kicked off up front with bounded concurrency (lazyBoundedMap)
      // but CONSUMED IN ORDER inside the serial loop below — there is no barrier.
      // So the first scene paints after content(1)+actions(1)+TTS(1) (same as
      // serial) while later content fetches run hidden behind earlier scenes'
      // actions/TTS. Content has no cross-scene dependency, so running it ahead is
      // safe; actions + TTS stay strictly serial to preserve previousSpeeches
      // threading and the pause-on-failure UX. With parallelism off this is exactly
      // the original one-at-a-time loop.
      try {
        const fetchContent = (outline: SceneOutline) =>
          fetchSceneContent(
            {
              outline,
              allOutlines: outlines,
              stageId: stage.id,
              pdfImages: params.pdfImages,
              imageMapping: params.imageMapping,
              stageInfo: params.stageInfo,
              agents: params.agents,
              languageDirective: params.languageDirective,
            },
            signal,
          );

        // Pre-warm content fetches (<= parallelConcurrency in flight), keyed by
        // outline id. Each promise resolves to a result and never rejects, so an
        // unexpected throw routes through the same mark-failed path as the serial
        // loop instead of taking sibling fetches down with it.
        const contentPromises = useParallelContent
          ? new Map(
              lazyBoundedMap(
                pending,
                parallelConcurrency,
                async (outline): Promise<SceneContentResult> => {
                  options.onPhaseChange?.('content', outline);
                  store.getState().recordScenePhase(outline.id, 'content', { status: 'running' });
                  try {
                    return await fetchContent(outline);
                  } catch (err) {
                    return {
                      success: false,
                      error: err instanceof Error ? err.message : 'Content generation failed',
                    };
                  }
                },
                {
                  shouldContinue: () =>
                    !abortRef.current && store.getState().generationEpoch === startEpoch,
                },
              ).map((promise, i) => [pending[i].id, promise] as const),
            )
          : null;

        let pausedByFailureOrAbort = false;
        let hadContentFailure = false;
        for (const outline of pending) {
          if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }

          store.getState().setCurrentGeneratingOrder(outline.order);

          // ══ THE ONE PIPELINE ══ (mode 'generate': fresh batch body — the
          // per-outline content/actions/tts steps below used to be inline;
          // they now live in runOutlineJob so regeneration and recovery are
          // the same phases with the same skip predicates).
          let contentResult: SceneContentResult;
          if (contentPromises) {
            contentResult = (await contentPromises.get(outline.id)) ?? {
              success: false,
              error: 'Content generation failed',
            };
          } else {
            options.onPhaseChange?.('content', outline);
            store.getState().setGenerationPhase('content');
            contentResult = await fetchContent(outline);
          }

          // Depth affordance: record the depth summary (reworked/attempts) so
          // the sidebar can badge scenes that needed corrective re-prompting.
          if (contentResult.depth) {
            store.getState().recordSceneDepth(outline.order, contentResult.depth);
          }

          if (!contentResult.success || !contentResult.content) {
            if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }
            store.getState().recordScenePhase(outline.id, 'content', {
              status: 'failed',
              error: contentResult.error || 'Content generation failed',
            });
            store.getState().addFailedOutline(outline);
            options.onSceneFailed?.(outline, contentResult.error || 'Content generation failed');
            // Surface and continue in both modes (Pillar 2 §4.8): a failure
            // marks the outline failed and the loop advances — retry/skip are
            // user actions on the retry cards. Pause only on cancel/abort.
            hadContentFailure = true;
            removeGeneratingOutline(outline.id);
            continue;
          }
          store.getState().recordScenePhase(outline.id, 'content', { status: 'done' });

          if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
            store.getState().setGenerationStatus('paused');
            pausedByFailureOrAbort = true;
            break;
          }

          // Step 2-3: actions + tts — the same one pipeline, generate mode,
          // with the batch's pre-warmed content handed in (no double fetch).
          options.onPhaseChange?.('actions', outline);
          store.getState().setGenerationPhase('actions');
          const jobResult = await runOutlineJob({
            outline,
            allOutlines: outlines,
            params,
            signal,
            mode: 'generate',
            previousSpeeches,
            preComputedContent: contentResult,
          });
          if (!jobResult.success) {
            if (abortRef.current || store.getState().generationEpoch !== startEpoch) {
              pausedByFailureOrAbort = true;
              break;
            }
            if (jobResult.failedPhase === 'tts') {
              // TTS is a background fill phase (Pillar 2 §4.6): failure never
              // fails the scene and never pauses the batch. The scene is
              // added with its speech actions missing audioId, and TTS is
              // retried by the repair queue / the per-scene UI affordance.
              log.warn(
                `TTS failed for scene "${outline.title}" — scene kept, audio pending: ${jobResult.error ?? 'unknown error'}`,
              );
              options.onSceneTtsFailed?.(outline, jobResult.error || 'TTS generation failed');
              // The scene still materialized: the phase row recorded failed
              // (the red card it drives comes from fill decay hydration),
              // but the batch carries on without demoting the outline.
              if (jobResult.scene) {
                removeGeneratingOutline(outline.id);
                useStageStore.getState().addScene(jobResult.scene);
                options.onSceneGenerated?.(jobResult.scene, outline.order);
                previousSpeeches = (jobResult.scene.actions || [])
                  .filter((a): a is SpeechAction => a.type === 'speech')
                  .map((a) => a.text);
              }
              continue;
            }
            options.onSceneFailed?.(
              outline,
              jobResult.error || (jobResult.failedPhase ?? 'job') + ' generation failed',
            );
            removeGeneratingOutline(outline.id);
            continue;
          }

          // Epoch changed — stage switched, discard this scene
          if (store.getState().generationEpoch !== startEpoch) {
            await removeFreshTtsAllocations(speechAllocationIds(jobResult.scene!));
            pausedByFailureOrAbort = true;
            break;
          }

          removeGeneratingOutline(outline.id);
          useStageStore.getState().addScene(jobResult.scene!);
          options.onSceneGenerated?.(jobResult.scene!, outline.order);
          previousSpeeches = (jobResult.scene!.actions || [])
            .filter((a): a is SpeechAction => a.type === 'speech')
            .map((a) => a.text);
        }

        if (!abortRef.current && !pausedByFailureOrAbort) {
          if (hadContentFailure || store.getState().failedOutlines.length > 0) {
            // Some outlines failed but the loop kept going; surface them for
            // retry/skip instead of signalling a clean completion.
            store.getState().setGenerationStatus('paused');
          } else {
            store.getState().setGenerationStatus('completed');
            store.getState().setGeneratingOutlines([]);
            store.getState().setGenerationComplete(true);
            options.onComplete?.();
            // Fill-phase drain (Pillar 2 §4.6): scenes whose TTS failed
            // during the loop get one background retry pass. Tied to this
            // run's abort controller so stop() / navigation away does not
            // keep the queue fetching after the session is gone.
            void drainPendingSceneTTS(
              store.getState().scenes,
              params.languageDirective || params.stageInfo.language,
              fetchAbortRef.current?.signal,
            );
          }
          store.getState().setGenerationPhase('idle');
        }
      } catch (err: unknown) {
        // AbortError is expected when stop() is called — don't treat as failure
        if (isAbortError(err)) {
          log.info('Generation aborted');
          store.getState().setGenerationStatus('paused');
        } else {
          throw err;
        }
      } finally {
        generatingRef.current = false;
        fetchAbortRef.current = null;
        generationLease();
      }
    },
    [options, store],
  );

  // Keep ref in sync so retrySingleOutline can call it
  generateRemainingRef.current = generateRemaining;

  // Queue-walk: after a repair settles (success or contained tts-phase failure),
  // the next failed outline runs automatically — one red-card click drains the
  // queue until a LEGITIMATE failure (content/actions hard error) parks it.
  // The settled outline is excluded when picking the head so a live failure
  // cannot re-queue into an infinite walk on itself.
  const retrySingleOutlineRef = useRef<((outlineId: string) => Promise<void>) | null>(null);
  const walkFailedQueueRef = useRef<(settledId: string | null) => void>(() => undefined);
  walkFailedQueueRef.current = (settledId: string | null) => {
    if (generatingRef.current) return;
    const current = store.getState().failedOutlines;
    const next = current.find((o) => o.id !== settledId);
    if (!next) return;
    void retrySingleOutlineRef.current?.(next.id);
  };

  const stop = useCallback(() => {
    abortRef.current = true;
    store.getState().bumpGenerationEpoch();
    fetchAbortRef.current?.abort();
    mediaAbortRef.current?.abort();
  }, [store]);

  const isGenerating = useCallback(() => generatingRef.current, []);

  /** Retry a single failed outline from scratch (content → actions → TTS). */
  const retrySingleOutline = useCallback(
    async (outlineId: string) => {
      const state = store.getState();
      const outline = state.failedOutlines.find((o) => o.id === outlineId);
      // RECOVERY INVARIANT (#reload-retry): the ref-only params started a
      // nothing-burger after a page reload — the retry card became a silent
      // no-op because `lastParamsRef` dies with the mount. Rebuild from the
      // persisted generation-session record (IndexedDB) plus live stage data
      // so post-reload retries actually run.
      let params = lastParamsRef.current;
      if (!params && state.stage) {
        try {
          const { loadGenerationParams } = await import('@/lib/utils/generation-session-store');
          const restored = (await loadGenerationParams(state.stage.id)) ?? {};
          const rebuilt: GenerationParams = {
            pdfImages: restored.pdfImages,
            agents: restored.agents,
            userProfile: restored.userProfile,
            languageDirective: restored.languageDirective || state.stage.languageDirective,
            stageInfo: {
              name: state.stage.name || '',
              description: state.stage.description,
              style: state.stage.style,
            },
            imageMapping: await loadImageMapping(
              (restored.pdfImages || [])
                .map((img) => (img as { storageId?: string }).storageId)
                .filter((id): id is string => Boolean(id)),
            ),
          };
          params = rebuilt;
          lastParamsRef.current = params;
        } catch (error) {
          log.warn('Retry params fallback load failed:', error);
        }
      }
      if (!outline || !state.stage || !params) return;
      const retryEpoch = state.generationEpoch;

      // Regen-lock (#571): never silently replace a scene that is open in
      // edit mode. Failed outlines have no completed scene yet so this is
      // structurally a no-op today, but the guard is in place for the
      // moment a "regenerate a successful scene" path routes through here.
      const lockedScene = state.scenes.find((s) => s.order === outline.order);
      if (
        lockedScene &&
        isSceneEditLocked({
          sceneId: lockedScene.id,
          mode: state.mode,
          currentSceneId: state.currentSceneId,
        })
      ) {
        return;
      }

      /* Unify: the retry is the SAME pipeline in repair mode — settled
         phases are skipped (content/actions via hash reuse, tts via dead-clip
         fill, media via byte-aware requeue); the recovery branch is a repair
         entry into the ONE queue, not a second train. */
      const removeGeneratingOutline = () => {
        const current = store.getState().generatingOutlines;
        if (!current.some((o) => o.id === outlineId)) return;
        store.getState().setGeneratingOutlines(current.filter((o) => o.id !== outlineId));
      };

      // Remove from failed list and mark as generating
      store.getState().retryFailedOutline(outlineId);
      store.getState().setGenerationStatus('generating');
      const currentGenerating = store.getState().generatingOutlines;
      if (!currentGenerating.some((o) => o.id === outline.id)) {
        store.getState().setGeneratingOutlines([...currentGenerating, outline]);
      }

      const abortController = new AbortController();
      const signal = abortController.signal;

      try {
        const sortedScenes = [...store.getState().scenes].sort((a, b) => a.order - b.order);
        const lastScene = sortedScenes[sortedScenes.length - 1];
        const previousSpeeches = lastScene
          ? (lastScene.actions || [])
              .filter((a): a is SpeechAction => a.type === 'speech')
              .map((a) => a.text)
          : [];

        const jobResult = await runOutlineJob({
          outline,
          allOutlines: state.outlines,
          params,
          signal,
          mode: 'repair',
          previousSpeeches,
        });

        if (!jobResult.success) {
          const failedPhase = jobResult.failedPhase ?? 'content';
          if (jobResult.failedPhase === 'tts') {
            // TTS fill failed: scene kept, phase row drives the red card.
            store.getState().recordScenePhase(outline.id, 'tts', {
              status: 'failed',
              error: jobResult.error || 'TTS generation failed',
            });
          } else {
            store.getState().recordScenePhase(outline.id, failedPhase, {
              status: 'failed',
              error: jobResult.error || `${failedPhase} generation failed`,
            });
          }
          store.getState().addFailedOutline(outline);
          store.getState().setGenerationStatus('paused');
          store.getState().setGenerationPhase('idle');
          // Contained failure (scene kept via tts-phase): the walk may move on
          // to the next failed outline — a hard content/actions failure parks.
          if (jobResult.failedPhase === 'tts') {
            walkFailedQueueRef.current(outline.id);
          }
          return;
        }

        if (store.getState().generationEpoch !== retryEpoch) {
          await removeFreshTtsAllocations(speechAllocationIds(jobResult.scene!));
          return;
        }

        removeGeneratingOutline();
        useStageStore.getState().addScene(jobResult.scene!);
        store.getState().setGenerationPhase('idle');

        // Resume remaining generation if there are pending outlines
        if (store.getState().generatingOutlines.length > 0 && lastParamsRef.current) {
          generateRemainingRef.current?.(lastParamsRef.current);
        } else if (store.getState().failedOutlines.length > 0) {
          // Continue the failed queue automatically — one Retry click drains
          // it until a legitimate failure parks the walk.
          walkFailedQueueRef.current(outline.id);
        } else {
          // This retry may have materialized the final outstanding slide. The
          // generateRemaining completion path is not reached on the retry flow,
          // so mark completion here too — otherwise a later delete would treat
          // the orphaned outline as pending and regenerate it.
          store.getState().markGenerationCompleteIfDone();
        }
      } catch (err) {
        if (!isAbortError(err)) {
          store.getState().addFailedOutline(outline);
        }
      }
    },
    [store],
  );
  // Keep the walk's ref binding current across renders.
  retrySingleOutlineRef.current = retrySingleOutline;

  return { generateRemaining, retrySingleOutline, stop, isGenerating };
}
