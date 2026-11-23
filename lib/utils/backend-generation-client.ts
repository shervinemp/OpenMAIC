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
  return { jobId: data.jobId, pollUrl: data.pollUrl };
}

export async function pollBackendGeneration(jobId: string): Promise<BackendGenerationJob | null> {
  const response = await fetch(`/api/generation/continue/${jobId}`, { cache: 'no-store' });
  const data = (await response.json().catch(() => ({}))) as {
    job?: BackendGenerationJob;
  };
  return response.ok ? data.job ?? null : null;
}

export async function cancelBackendGeneration(jobId: string): Promise<void> {
  await fetch(`/api/generation/continue/${jobId}`, { method: 'DELETE' }).catch(() => undefined);
}
