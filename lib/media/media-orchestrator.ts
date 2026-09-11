/**
 * Media Generation Orchestrator
 *
 * Dispatches media generation API calls for all mediaGenerations across outlines.
 * Runs entirely on the frontend — calls /api/generate/image and /api/generate/video,
 * fetches result blobs, stores in IndexedDB, and updates the Zustand store.
 */

import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useStageStore } from '@/lib/store/stage';
import { useSettingsStore } from '@/lib/store/settings';
import { db, mediaFileKey } from '@/lib/utils/database';
import type { SceneOutline } from '@/lib/types/generation';
import type { MediaGenerationRequest } from '@/lib/media/types';
import { fetchProxiedMediaUrl } from '@/lib/media/proxy-media-cache';
import { createLogger } from '@/lib/logger';

const log = createLogger('MediaOrchestrator');

// ==================== Recovery policy ====================
//
// A configured generation backend (local ComfyUI, a hosted provider, whatever)
// is never abandoned because it failed a few requests. Two layers of recovery:
//
// 1. In-pass auto-retry: every failed request is re-attempted with exponential
//    backoff (3s -> 48s, capped) before the serial queue moves on. Structured
//    terminal errors (errorCode, e.g. CONTENT_SENSITIVE) skip intra-pass
//    retries - a deterministic rejection will not fix itself - but ...
// 2. Pass-level recovery: failed tasks are NEVER permanently skipped; the next
//    generation pass (resume, reload, or new scenes finishing) re-enqueues
//    every not-done task. A backend failure pattern therefore recovers as soon
//    as the cause is fixed, without any manual per-item retry click.

/** Intra-pass retry ceiling (initial attempt + retries). */
export const MEDIA_AUTO_RETRY_LIMIT = 6;
/** First backoff delay; doubles each retry, capped at MEDIA_RETRY_MAX_DELAY_MS. */
const MEDIA_RETRY_BASE_DELAY_MS = 3_000;
const MEDIA_RETRY_MAX_DELAY_MS = 48_000;

/**
 * Test seam: the backoff sleep. Tests inject an instant resolver so the retry
 * loop is deterministic without fake timers. Must be awaited (real timers).
 */
export const mediaRetrySleep: { wait: (ms: number) => Promise<void> } = {
  wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/** Error with a structured errorCode from the API */
class MediaApiError extends Error {
  errorCode?: string;
  constructor(message: string, errorCode?: string) {
    super(message);
    this.errorCode = errorCode;
  }
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('Aborted', 'AbortError');
  return Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

/**
 * Launch media generation for all mediaGenerations declared in outlines.
 * Runs in parallel with content/action generation — does not block.
 */
export async function generateMediaForOutlines(
  outlines: SceneOutline[],
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const settings = useSettingsStore.getState();
  const store = useMediaGenerationStore.getState();

  // Per-outline phase recording (Pillar 2): each request maps back to its
  // owning outline so the orchestrator can drive the persisted `media` phase
  // (running on first start, done/failed once the outline's batch settles).
  const outlineByElement = new Map<string, string>();
  for (const outline of outlines) {
    if (!outline.mediaGenerations) continue;
    for (const mg of outline.mediaGenerations) outlineByElement.set(mg.elementId, outline.id);
  }

  // Collect all media requests
  const allRequests: MediaGenerationRequest[] = [];
  for (const outline of outlines) {
    if (!outline.mediaGenerations) continue;
    for (const mg of outline.mediaGenerations) {
      // Filter by enabled flags
      if (mg.type === 'image' && !settings.imageGenerationEnabled) continue;
      if (mg.type === 'video' && !settings.videoGenerationEnabled) continue;
      // Skip only already-completed media. Failed tasks are NOT skipped: the
      // recovery policy ("never give up while generation is configured")
      // re-enqueues them on every pass, so a backend that failed earlier
      // recovers automatically once its cause is fixed.
      const existing = store.getTask(mg.elementId);
      if (existing?.status === 'done') continue;
      allRequests.push(mg);
    }
  }

  if (allRequests.length === 0) return;

  // Enqueue all as pending
  useMediaGenerationStore.getState().enqueueTasks(stageId, allRequests);

  const mediaStats = new Map<string, { total: number; done: number; failed: number }>();
  for (const req of allRequests) {
    const outlineId = outlineByElement.get(req.elementId);
    if (!outlineId) continue;
    const stats = mediaStats.get(outlineId) ?? { total: 0, done: 0, failed: 0 };
    stats.total += 1;
    mediaStats.set(outlineId, stats);
  }
  const phaseStarted = new Set<string>();

  // Process requests serially — image/video APIs have limited concurrency
  for (const req of allRequests) {
    if (abortSignal?.aborted) break;
    const outlineId = outlineByElement.get(req.elementId);
    if (outlineId && !phaseStarted.has(outlineId)) {
      phaseStarted.add(outlineId);
      useStageStore.getState().recordScenePhase(outlineId, 'media', { status: 'running' });
    }
    await generateSingleMedia(req, stageId, abortSignal);
    if (!outlineId) continue;
    if (abortSignal?.aborted) break;
    const stats = mediaStats.get(outlineId);
    if (!stats) continue;
    const task = useMediaGenerationStore.getState().getTask(req.elementId);
    if (task?.status === "done") stats.done += 1; else stats.failed += 1;
    if (stats.done + stats.failed === stats.total) {
      useStageStore.getState().recordScenePhase(
        outlineId,
        'media',
        stats.failed === 0
          ? { status: 'done' }
          : { status: 'failed', error: `${stats.failed}/${stats.total} media item(s) failed` },
      );
    }
  }
}

/**
 * Retry a single failed media task.
 */
export async function retryMediaTask(
  elementId: string,
  _target?: { readonly elementId: string; readonly sceneId?: string; readonly slideId?: string },
): Promise<void> {
  const store = useMediaGenerationStore.getState();
  const task = store.getTask(elementId);
  if (!task || task.status !== 'failed') return;

  // Check if the corresponding generation type is still enabled in global settings
  const settings = useSettingsStore.getState();
  if (task.type === 'image' && !settings.imageGenerationEnabled) {
    store.markFailed(elementId, 'Generation disabled', 'GENERATION_DISABLED');
    return;
  }
  if (task.type === 'video' && !settings.videoGenerationEnabled) {
    store.markFailed(elementId, 'Generation disabled', 'GENERATION_DISABLED');
    return;
  }

  // Remove persisted failure record from DB so a fresh result can be written
  const dbKey = mediaFileKey(task.stageId, elementId);
  await db.mediaFiles.delete(dbKey).catch(() => {});

  store.markPendingForRetry(elementId);
  await generateSingleMedia(
    {
      type: task.type,
      prompt: task.prompt,
      elementId: task.elementId,
      aspectRatio: task.params.aspectRatio as MediaGenerationRequest['aspectRatio'],
      style: task.params.style,
    },
    task.stageId,
  );
}

/** Build the renderer retry scope while classic retries remain placeholder-keyed. */
export function mediaRetryTarget(
  elementId: string,
  sceneId: string | undefined,
  sceneData: unknown,
): { elementId: string; sceneId?: string; slideId?: string } {
  const slideId =
    sceneData && typeof sceneData === 'object' && 'canvas' in sceneData
      ? (sceneData as { canvas?: { id?: string } }).canvas?.id
      : undefined;
  return { elementId, ...(sceneId ? { sceneId } : {}), ...(slideId ? { slideId } : {}) };
}

// ==================== Internal ====================

async function generateSingleMedia(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  // In-pass recovery loop: failures are retried with exponential backoff. A
  // structured terminal error (deterministic rejection, e.g. content policy)
  // opts out of intra-pass retries but is still retried by later passes.
  for (let attempt = 0; attempt < MEDIA_AUTO_RETRY_LIMIT; attempt++) {
    const isLastAttempt = attempt === MEDIA_AUTO_RETRY_LIMIT - 1;
    try {
      await generateSingleMediaOnce(req, stageId, abortSignal);
      return;
    } catch (err) {
      if (abortSignal?.aborted) {
        // A submitted video MaaS task keeps running to a billable terminal
        // state server-side even after this client stops polling. Mark either
        // media task retryable instead of leaving it stuck in `generating`;
        // note that retrying a video submits a second job rather than
        // resuming the first.
        const abortedMessage =
          req.type === 'video'
            ? 'Video generation polling was aborted; retry to submit a new job'
            : 'Image generation was aborted; retry to submit a new request';
        useMediaGenerationStore.getState().markFailed(req.elementId, abortedMessage);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof MediaApiError ? err.errorCode : undefined;
      if (errorCode) {
        // Deterministic rejection: intra-pass retries cannot fix it. Record
        // and surface; the next generation pass will still re-attempt it.
        log.warn(
          `Terminal error on ${req.elementId} (${errorCode}): ${message}; will retry on the next generation pass`,
        );
        useMediaGenerationStore.getState().markFailed(req.elementId, message, errorCode);
        // Persist structured terminal errors to IndexedDB so they survive page refresh
        await db.mediaFiles
          .put({
            id: mediaFileKey(stageId, req.elementId),
            stageId,
            type: req.type,
            blob: new Blob(), // empty placeholder
            mimeType: req.type === 'image' ? 'image/png' : 'video/mp4',
            size: 0,
            prompt: req.prompt,
            params: JSON.stringify({ aspectRatio: req.aspectRatio, style: req.style }),
            error: message,
            errorCode,
            createdAt: Date.now(),
          })
          .catch(() => {}); // best-effort
        return;
      }
      if (isLastAttempt) {
        log.error(`Failed ${req.elementId}:`, message);
        useMediaGenerationStore.getState().markFailed(req.elementId, message);
        // Transient failures stay in memory only; the next generation pass
        // re-enqueues them (pass-level recovery).
        return;
      }
      const delay = Math.min(MEDIA_RETRY_BASE_DELAY_MS * 2 ** attempt, MEDIA_RETRY_MAX_DELAY_MS);
      log.warn(
        `Auto-retrying ${req.elementId} in ${delay}ms (attempt ${attempt + 1}/${MEDIA_AUTO_RETRY_LIMIT - 1}):`,
        message,
      );
      throwIfAborted(abortSignal);
      if (abortSignal?.aborted) throw createAbortError();
      await mediaRetrySleep.wait(delay);
      if (abortSignal?.aborted) throw createAbortError();
    }
  }
}

async function generateSingleMediaOnce(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const store = useMediaGenerationStore.getState();
  store.markGenerating(req.elementId);

  const paramsJson = JSON.stringify({
    aspectRatio: req.aspectRatio,
    style: req.style,
  });

    if (req.type === 'image') {
      const result = await callImageApi(req, stageId, abortSignal);

      // CDN path: server already uploaded to OSS
      if (result.ossUrl) {
        throwIfAborted(abortSignal);
        await db.mediaFiles.put({
          id: mediaFileKey(stageId, req.elementId),
          stageId,
          type: 'image',
          blob: new Blob([]),
          mimeType: 'image/png',
          size: 0,
          ossKey: result.ossUrl,
          prompt: req.prompt,
          params: paramsJson,
          createdAt: Date.now(),
        });
        useMediaGenerationStore.getState().markDone(req.elementId, result.ossUrl);
        return;
      }

      // Fallback: fetch blob via proxy-media
      throwIfAborted(abortSignal);
      const blob = await fetchAsBlob(result.url);
      await db.mediaFiles.put({
        id: mediaFileKey(stageId, req.elementId),
        stageId,
        type: 'image',
        blob,
        mimeType: 'image/png',
        size: blob.size,
        prompt: req.prompt,
        params: paramsJson,
        createdAt: Date.now(),
      });
      const objectUrl = URL.createObjectURL(blob);
      useMediaGenerationStore.getState().markDone(req.elementId, objectUrl);
    } else {
      const result = await callVideoApi(req, abortSignal);

      // CDN path: server already uploaded to OSS
      if (result.ossUrl) {
        throwIfAborted(abortSignal);
        await db.mediaFiles.put({
          id: mediaFileKey(stageId, req.elementId),
          stageId,
          type: 'video',
          blob: new Blob([]),
          mimeType: 'video/mp4',
          size: 0,
          ossKey: result.ossUrl,
          posterOssKey: result.posterOssUrl,
          prompt: req.prompt,
          params: paramsJson,
          createdAt: Date.now(),
        });
        useMediaGenerationStore
          .getState()
          .markDone(req.elementId, result.ossUrl, result.posterOssUrl);
        return;
      }

      // Fallback: fetch blob via proxy-media
      throwIfAborted(abortSignal);
      const blob = await fetchAsBlob(result.url);
      const posterBlob = result.poster
        ? await fetchAsBlob(result.poster).catch(() => undefined)
        : undefined;
      await db.mediaFiles.put({
        id: mediaFileKey(stageId, req.elementId),
        stageId,
        type: 'video',
        blob,
        mimeType: 'video/mp4',
        size: blob.size,
        poster: posterBlob,
        prompt: req.prompt,
        params: paramsJson,
        createdAt: Date.now(),
      });
      const objectUrl = URL.createObjectURL(blob);
      const posterObjectUrl = posterBlob ? URL.createObjectURL(posterBlob) : undefined;
      useMediaGenerationStore.getState().markDone(req.elementId, objectUrl, posterObjectUrl);
    }
}

async function callImageApi(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<{ url: string; ossUrl?: string }> {
  const settings = useSettingsStore.getState();
  const providerConfig = settings.imageProvidersConfig?.[settings.imageProviderId];

  const response = await fetch('/api/generate/image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-image-provider': settings.imageProviderId || '',
      'x-image-model': settings.imageModelId || '',
      'x-api-key': providerConfig?.apiKey || '',
      'x-base-url': providerConfig?.baseUrl || '',
    },
    body: JSON.stringify({
      prompt: req.prompt,
      aspectRatio: req.aspectRatio,
      style: req.style,
      stageId,
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new MediaApiError(data.error || `Image API returned ${response.status}`, data.errorCode);
  }

  const data = await response.json();
  if (!data.success)
    throw new MediaApiError(data.error || 'Image generation failed', data.errorCode);

  // Result may have ossUrl (CDN direct), url, or base64
  const ossUrl = data.result?.ossUrl as string | undefined;
  const url =
    data.result?.url || (data.result?.base64 ? `data:image/png;base64,${data.result.base64}` : '');
  if (!ossUrl && !url) throw new Error('No image URL in response');
  return { url, ossUrl };
}

async function callVideoApi(
  req: MediaGenerationRequest,
  abortSignal?: AbortSignal,
): Promise<{
  url: string;
  poster?: string;
  ossUrl?: string;
  posterOssUrl?: string;
  width?: number;
  height?: number;
  duration?: number;
}> {
  const settings = useSettingsStore.getState();
  const providerConfig = settings.videoProvidersConfig?.[settings.videoProviderId];

  const response = await fetch('/api/generate/video', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-video-provider': settings.videoProviderId || '',
      'x-video-model': settings.videoModelId || '',
      'x-api-key': providerConfig?.apiKey || '',
      'x-base-url': providerConfig?.baseUrl || '',
    },
    body: JSON.stringify({
      prompt: req.prompt,
      aspectRatio: req.aspectRatio,
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new MediaApiError(data.error || `Video API returned ${response.status}`, data.errorCode);
  }

  const data = await response.json();
  if (!data.success)
    throw new MediaApiError(data.error || 'Video generation failed', data.errorCode);

  const url = data.result?.url;
  if (!url) throw new Error('No video URL in response');
  return {
    url,
    poster: data.result?.poster,
    ossUrl: data.result?.ossUrl,
    posterOssUrl: data.result?.posterOssUrl,
    width: data.result?.width,
    height: data.result?.height,
    duration: data.result?.duration,
  };
}

async function fetchAsBlob(url: string): Promise<Blob> {
  // For data URLs, convert directly
  if (url.startsWith('data:')) {
    const res = await fetch(url);
    return res.blob();
  }
  // For remote URLs, proxy through our server to bypass CORS restrictions.
  // Routed through the shared proxy-media negative cache so a permanently
  // failed URL (4xx) is not re-fetched by retries or later generation passes.
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const res = await fetchProxiedMediaUrl(url);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Proxy fetch failed: ${res.status}`);
    }
    return res.blob();
  }
  // Relative URLs (shouldn't happen, but handle gracefully)
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch blob: ${res.status}`);
  return res.blob();
}
