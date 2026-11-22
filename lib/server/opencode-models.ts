/**
 * Runtime model discovery for the native `opencode` provider.
 *
 * The gateway's catalog is dynamic and bare ids can collide across categories
 * (e.g. a bare id resolving to the wrong, rate-limited category). Instead of
 * pinning a model id in env, we ask the provider's base URL for its current
 * /v1/models list and rank it: qualified `provider/model` ids win, and a bare
 * id that is merely a qualified id's suffix is dropped so it can never be
 * picked as the ambiguous twin.
 *
 * Discovery is best-effort and cached. Any failure leaves the caller's existing
 * model resolution untouched — never fail a request because a catalog was
 * temporarily unavailable.
 */

import { getProvider } from '@/lib/ai/providers';
import { fetchModels } from '@/lib/server/model-fetch';
import { resolveBaseUrl } from '@/lib/server/provider-config';

const OPENCODE_PROVIDER_ID = 'opencode';

const NON_CHAT_PATTERN = /(tts|asr|whisper|embedding|rerank|mineru|image|video|voxcpm|moderation)/i;
const CACHE_TTL_MS = 60_000;

/**
 * Rank discovered ids so the first entry is the safest default.
 *
 * 1. Qualified ids (`provider/model`) are unambiguous and come first.
 * 2. A bare id that is a qualified id's suffix is dropped — it is the twin
 *    that can resolve to the wrong gateway category.
 * 3. Everything else follows, sorted, so a catalog change cannot silently
 *    reorder the top pick.
 */
export function rankOpenCodeModels(ids: string[]): string[] {
  const cleaned = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
    .filter((id) => !NON_CHAT_PATTERN.test(id))
    .sort((a, b) => a.localeCompare(b));

  const qualified = cleaned.filter((id) => id.includes('/'));
  const qualifiedSuffixes = new Set(qualified.map((id) => id.slice(id.lastIndexOf('/') + 1)));
  const bare = cleaned.filter((id) => !id.includes('/') && !qualifiedSuffixes.has(id));

  return [...qualified, ...bare];
}

type ModelLister = (baseUrl: string, apiKey: string) => Promise<Array<{ id: string }>>;

interface CacheEntry {
  expiresAt: number;
  models: string[];
}

let cache: CacheEntry | undefined;
let inFlight: Promise<string[]> | undefined;

/** The configured base URL for the OpenCode provider (registry default if unset). */
function openCodeBaseUrl(): string | undefined {
  return resolveBaseUrl(OPENCODE_PROVIDER_ID) || getProvider(OPENCODE_PROVIDER_ID)?.defaultBaseUrl;
}

/**
 * Fetch and rank the provider's current chat models. Returns an empty array on
 * failure or when there is no base URL. Results are cached for CACHE_TTL_MS.
 */
export async function discoverOpenCodeModels(
  options: { baseUrl?: string; listModels?: ModelLister } = {},
): Promise<string[]> {
  const baseUrl = options.baseUrl ?? openCodeBaseUrl();
  if (!baseUrl) return [];

  const listModels = options.listModels ?? fetchModels;
  if (!options.listModels) {
    if (cache && cache.expiresAt > Date.now()) return cache.models;
    if (inFlight) return inFlight;
  }

  const load = async (): Promise<string[]> => {
    try {
      const models = await listModels(baseUrl, '');
      const ranked = rankOpenCodeModels(models.map((m) => m.id));
      if (!options.listModels) cache = { expiresAt: Date.now() + CACHE_TTL_MS, models: ranked };
      return ranked;
    } catch {
      // Fail-open: keep whatever model the caller would otherwise have used.
      return [];
    }
  };

  if (!options.listModels) {
    inFlight = load().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }
  return load();
}

/** The model string to use when no client model and no operator default exist. */
export async function resolveOpenCodeDefaultModel(
  options: { baseUrl?: string; listModels?: ModelLister } = {},
): Promise<string | undefined> {
  const models = await discoverOpenCodeModels(options);
  const first = models[0];
  return first ? `${OPENCODE_PROVIDER_ID}:${first}` : undefined;
}
