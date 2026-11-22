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
 * Discovery is best-effort, bounded, cached per base URL, and negatively cached
 * on failure. A failure never blocks or changes the caller's model resolution.
 */

import { getProvider } from '@/lib/ai/providers';
import { fetchModels } from '@/lib/server/model-fetch';
import { resolveApiKey, resolveBaseUrl } from '@/lib/server/provider-config';

const OPENCODE_PROVIDER_ID = 'opencode';

const NON_CHAT_PATTERN = /(tts|asr|whisper|embedding|rerank|mineru|image|video|voxcpm|moderation)/i;
const CACHE_TTL_MS = 60_000;
/** Failures are cached briefly so a down gateway cannot be retried on every load. */
const NEGATIVE_CACHE_TTL_MS = 5_000;
const DISCOVERY_TIMEOUT_MS = 10_000;

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

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string[]>>();

/** The configured base URL for the OpenCode provider (registry default if unset). */
function openCodeBaseUrl(): string | undefined {
  return resolveBaseUrl(OPENCODE_PROVIDER_ID) || getProvider(OPENCODE_PROVIDER_ID)?.defaultBaseUrl;
}

/**
 * Fetch and rank the provider's current chat models. Returns an empty array on
 * failure or when there is no base URL. Results are cached per base URL.
 */
export async function discoverOpenCodeModels(
  options: { baseUrl?: string; listModels?: ModelLister } = {},
): Promise<string[]> {
  const baseUrl = options.baseUrl ?? openCodeBaseUrl();
  if (!baseUrl) return [];

  const listModels = options.listModels ?? fetchModels;
  // A keyed gateway needs its key for /v1/models too; the local bridge ignores it.
  const apiKey = options.listModels ? '' : resolveApiKey(OPENCODE_PROVIDER_ID);

  if (!options.listModels) {
    const hit = cache.get(baseUrl);
    if (hit && hit.expiresAt > Date.now()) return hit.models;
    const pending = inFlight.get(baseUrl);
    if (pending) return pending;
  }

  const load = async (): Promise<string[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const models = await Promise.race([
        listModels(baseUrl, apiKey),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('OpenCode model discovery timed out')),
            DISCOVERY_TIMEOUT_MS,
          );
        }),
      ]);
      const ranked = rankOpenCodeModels(models.map((m) => m.id));
      if (!options.listModels) cache.set(baseUrl, { expiresAt: Date.now() + CACHE_TTL_MS, models: ranked });
      return ranked;
    } catch {
      if (!options.listModels) {
        cache.set(baseUrl, { expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS, models: [] });
      }
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  if (!options.listModels) {
    const pending = load().finally(() => {
      inFlight.delete(baseUrl);
    });
    inFlight.set(baseUrl, pending);
    return pending;
  }
  return load();
}
