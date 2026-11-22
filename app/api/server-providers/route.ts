import {
  getServerProviders,
  getServerTTSProviders,
  getServerASRProviders,
  getServerPDFProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerWebSearchProviders,
  getParallelSceneConcurrency,
} from '@/lib/server/provider-config';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { discoverOpenCodeModels, isOpenCodeGatewayConfigured } from '@/lib/server/opencode-models';

const log = createLogger('ServerProviders');

export async function GET() {
  try {
    const providers = getServerProviders();
    // The Settings picker reads this endpoint. For an OpenCode gateway, fill
    // the provider's model list from the live catalog instead of an env pin,
    // so the user can pick from whatever models OpenCode currently exposes.
    if (isOpenCodeGatewayConfigured()) {
      const discovered = await discoverOpenCodeModels();
      if (discovered.length > 0) {
        const pinned = providers.openrouter?.models ?? [];
        providers.openrouter = {
          ...providers.openrouter,
          models: [...new Set([...pinned, ...discovered])],
        };
      }
    }

    return apiSuccess({
      providers,
      tts: getServerTTSProviders(),
      asr: getServerASRProviders(),
      pdf: getServerPDFProviders(),
      image: getServerImageProviders(),
      video: getServerVideoProviders(),
      webSearch: getServerWebSearchProviders(),
      generation: {
        parallelSceneConcurrency: getParallelSceneConcurrency(),
      },
    });
  } catch (error) {
    log.error('Error fetching server providers:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
