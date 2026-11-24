'use client';

import { getCurrentModelConfig, getStageRoutesHeaderValue } from '@/lib/utils/model-config';
import { useSettingsStore } from '@/lib/store/settings';

export interface BackendGenerationJob {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  stageId: string;
  message: string;
  scenesGenerated: number;
  scenesFailed: number;
  totalScenes?: number;
  error?: string;
  updatedAt: string;
}

/**
 * Runs started by this browser. Synchronous so generation guards never need
 * an extra network round-trip (and never interfere with provider fetch mocks).
 * On a fresh page load the document's `producer: 'server-job'` is the durable
 * equivalent; this set covers the window between start and settlement.
 */
const locallyActiveRuns = new Set<string>();

export function markBackendRunActive(stageId: string): void {
  locallyActiveRuns.add(stageId);
}

export function clearBackendRun(stageId: string): void {
  locallyActiveRuns.delete(stageId);
}

export function hasActiveBackendRun(stageId: string): boolean {
  return locallyActiveRuns.has(stageId);
}

function generationHeaders(): Record<string, string> {
  const config = getCurrentModelConfig();
  const settings = useSettingsStore.getState();
  const imageProvider = settings.imageProvidersConfig?.[settings.imageProviderId];
  const videoProvider = settings.videoProvidersConfig?.[settings.videoProviderId];
  return {
    'content-type': 'application/json',
    ...(getStageRoutesHeaderValue() ? { 'x-model-routes': getStageRoutesHeaderValue()! } : {}),
    'x-model': config.modelString || '',
    'x-api-key': config.apiKey || '',
    'x-base-url': config.baseUrl || '',
    'x-provider-type': config.providerType || '',
    'x-image-provider': settings.imageProviderId || '',
    'x-image-model': settings.imageModelId || '',
    'x-image-api-key': imageProvider?.apiKey || '',
    'x-image-base-url': imageProvider?.baseUrl || '',
    'x-video-provider': settings.videoProviderId || '',
    'x-video-model': settings.videoModelId || '',
    'x-video-api-key': videoProvider?.apiKey || '',
    'x-video-base-url': videoProvider?.baseUrl || '',
    'x-image-generation-enabled': String(settings.imageGenerationEnabled ?? false),
    'x-video-generation-enabled': String(settings.videoGenerationEnabled ?? false),
  };
}

export async function startBackendGeneration(
  stageId: string,
  options: {
    includeFailed?: boolean;
    languageDirective?: string;
    userProfile?: string;
    taskEngineMode?: boolean;
    /** Retry only these outlines; omit to fill all missing scenes. */
    outlineIds?: string[];
  } = {},
): Promise<{ jobId: string; pollUrl: string }> {
  const response = await fetch('/api/generation/continue', {
    method: 'POST',
    headers: generationHeaders(),
    body: JSON.stringify({ stageId, ...options }),
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
    jobId?: string;
    pollUrl?: string;
  };
  if (!response.ok || !data.jobId || !data.pollUrl) {
    throw new Error(data.error?.message || `Generation start failed (${response.status})`);
  }
  markBackendRunActive(stageId);
  return { jobId: data.jobId, pollUrl: data.pollUrl };
}

/** The single source of truth for "is a server job producing this course?". */
export async function getActiveBackendRun(stageId: string): Promise<BackendGenerationJob | null> {
  try {
    const response = await fetch(
      `/api/generation/continue?stageId=${encodeURIComponent(stageId)}`,
      { cache: 'no-store' },
    );
    if (!response.ok) return null;
    const data = (await response.json().catch(() => ({}))) as { job?: BackendGenerationJob };
    if (data.job) markBackendRunActive(stageId);
    else clearBackendRun(stageId);
    return data.job ?? null;
  } catch {
    // This is a guard, not a capability: an unreachable status endpoint must
    // not break the browser's existing generation path.
    return null;
  }
}

/** Route an in-course Retry through the same backend control plane as Home. */
export async function retryOutlineOnServer(stageId: string, outlineId: string): Promise<void> {
  await startBackendGeneration(stageId, { outlineIds: [outlineId], includeFailed: true });
}

export async function pollBackendGeneration(jobId: string): Promise<BackendGenerationJob | null> {
  const response = await fetch(`/api/generation/continue/${jobId}`, { cache: 'no-store' });
  const data = (await response.json().catch(() => ({}))) as {
    job?: BackendGenerationJob;
  };
  const job = response.ok ? data.job ?? null : null;
  if (job?.stageId && (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled')) {
    clearBackendRun(job.stageId);
  }
  return job;
}

export async function cancelBackendGeneration(jobId: string): Promise<void> {
  const job = await pollBackendGeneration(jobId);
  await fetch(`/api/generation/continue/${jobId}`, { method: 'DELETE' }).catch(() => undefined);
  if (job?.stageId) clearBackendRun(job.stageId);
}
