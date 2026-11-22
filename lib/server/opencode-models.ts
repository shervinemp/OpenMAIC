/**
 * Runtime model discovery for OpenCode gateways.
 *
 * The bridge's catalog is dynamic and its bare model ids collide across the
 * Zen and Go categories (a bare `hy4-flash-free` resolves to Zen -> 429). So
 * instead of pinning a model id in env, we ask the gateway for its current
 * /v1/models list and rank it: preferred-prefix ids win, and a bare id that is
 * merely the suffix of a preferred id is dropped so it can never be picked.
 *
 * Discovery is best-effort and cached. Any failure leaves the caller's existing
 * model resolution untouched — never fail the request because a catalog was
 * temporarily unavailable.
 */

import { fetchModels } from '@/lib/server/model-fetch';
import { resolveBaseUrl } from '@/lib/server/provider-config';

const OPENCODE_PROVIDER_ID = 'openrouter';

/** Gateway hosts that need OpenCode-specific request headers. */
const OPENCODE_GATEWAY_RE =
  /^https?:\/\/(?:opencode\.ai\/(?:inference\/go|zen)|(?:127\.0\.0\.1|localhost):8787)(?:\/|$)/i;

/** Ids under this prefix are preferred; overridable without a code change. */
function preferredPrefix(): string {
  return process.env.OPENCODE_MODEL_PREFIX?.trim().replace(/\/+$/, '') || 'opencode-go';
}

const NON_CHAT_PATTERN = /(tts|asr|whisper|embedding|rerank|mineru|image|video|voxcpm|moderation)/i;
const CACHE_TTL_MS = 60_000;

/** Whether a base URL points at an OpenCode-compatible gateway. */
export function isOpenCodeGatewayBaseUrl(baseUrl: string | undefined): boolean {
  return !!baseUrl && OPENCODE_GATEWAY_RE.test(baseUrl);
}

/** Whether the server's LLM provider is currently pointed at an OpenCode gateway. */
export function isOpenCodeGatewayConfigured(): boolean {
  return isOpenCodeGatewayBaseUrl(resolveBaseUrl(OPENCODE_PROVIDER_ID));
}

/**
 * Rank discovered ids so the first entry is the safest default.
 *
 * 1. Keep ids under the preferred prefix (e.g. `opencode-go/*`).
 * 2. Drop a bare id when the same id also exists under the preferred prefix —
 *    that bare id is the ambiguous one that resolves to the wrong category.
 * 3. Everything else follows, sorted, so a catalog change cannot silently
 *    reorder the top pick.
 */
export function rankOpenCodeModels(ids: string[]): string[] {
  const cleaned = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
    .filter((id) => !NON_CHAT_PATTERN.test(id))
    .sort((a, b) => a.localeCompare(b));

  const prefix = preferredPrefix();
  const qualifiedPrefix = `${prefix}/`;
  const preferred = cleaned.filter((id) => id.startsWith(qualifiedPrefix));
  // A qualified id (`provider/model`) is unambiguous; a bare id can collide
  // across gateway categories, so qualified ids always rank above bare ones.
  const qualified = cleaned.filter((id) => id.includes('/') && !id.startsWith(qualifiedPrefix));
  const qualifiedSuffixes = new Set(
    [...preferred, ...qualified].map((id) => id.slice(id.lastIndexOf('/') + 1)),
  );
  // Drop a bare id when a qualified id ends with the same name — that is the
  // ambiguous twin that resolves to the wrong category on the bridge.
  const bare = cleaned.filter((id) => !id.includes('/') && !qualifiedSuffixes.has(id));

  return [...preferred, ...qualified, ...bare];
}

type ModelLister = (baseUrl: string, apiKey: string) => Promise<Array<{ id: string }>>;

interface CacheEntry {
  expiresAt: number;
  models: string[];
}

let cache: CacheEntry | undefined;
let inFlight: Promise<string[]> | undefined;

/**
 * Fetch and rank the gateway's current chat models. Returns an empty array when
 * the gateway is not configured, when models are explicitly pinned in env, or
 * when discovery fails. Results are cached for CACHE_TTL_MS.
 */
export async function discoverOpenCodeModels(
  options: { baseUrl?: string; listModels?: ModelLister } = {},
): Promise<string[]> {
  const baseUrl = options.baseUrl ?? resolveBaseUrl(OPENCODE_PROVIDER_ID);
  if (!isOpenCodeGatewayBaseUrl(baseUrl)) return [];

  const listModels = options.listModels ?? fetchModels;
  // An explicit operator pin is authoritative — don't spend a request or let a
  // discovered model shadow it.
  if (!options.listModels && process.env.OPENROUTER_MODELS?.trim()) return [];

  if (!options.listModels) {
    if (cache && cache.expiresAt > Date.now()) return cache.models;
    if (inFlight) return inFlight;
  }

  const load = async (): Promise<string[]> => {
    try {
      const models = await listModels(baseUrl!, '');
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
