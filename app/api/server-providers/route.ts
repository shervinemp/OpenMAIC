import {
  getServerProviders,
  getServerTTSProviders,
  getServerASRProviders,
  getServerPDFProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerWebSearchProviders,
  getParallelSceneConcurrency,
  getParallelActionsConcurrency,
} from '@/lib/server/provider-config';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { discoverOpenCodeModels } from '@/lib/server/opencode-models';

const log = createLogger('ServerProviders');

export async function GET() {
  try {
    const providers = getServerProviders();
    // The Settings picker reads this endpoint. The native `opencode` provider
    // has no hardcoded models — expose the live catalog so it can be selected
    // like any other configured provider.
    const discovered = await discoverOpenCodeModels();
    if (discovered.length > 0) {
      providers.opencode = {
        ...providers.opencode,
        models: [...new Set([...(providers.opencode?.models ?? []), ...discovered])],
      };
    }

    return apiSuccess({
      // Lets a fresh browser seed its LLM selection from local env instead of
      // auto-picking the first configured provider.
      defaultModel: process.env.DEFAULT_MODEL?.trim() || undefined,
      providers,
      tts: getServerTTSProviders(),
      asr: getServerASRProviders(),
      pdf: getServerPDFProviders(),
      image: getServerImageProviders(),
      video: getServerVideoProviders(),
      webSearch: getServerWebSearchProviders(),
      generation: {
        parallelSceneConcurrency: getParallelSceneConcurrency(),
        parallelActionsConcurrency: getParallelActionsConcurrency(),
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
