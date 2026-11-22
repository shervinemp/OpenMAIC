/**
 * `DECISION_ROUTES` parsing.
 *
 * One JSON env object, keyed by decision site. Every entry is optional and
 * independent: configuring `quiz-verify` never changes grading, and an
 * invalid entry is ignored with a warning rather than failing a request.
 *
 * Precedence inside the layer is deliberately simple: this config is the only
 * source. `MODEL_ROUTES` stays the source for the fallback LLM call.
 */

import { createLogger } from '@/lib/logger';

import {
  DECISION_SITES,
  type DecisionFallback,
  type DecisionMode,
  type DecisionProviderId,
  type DecisionSiteConfig,
  type DecisionSiteId,
} from './types';

const log = createLogger('decision-config');

const DEFAULT_TIMEOUT_MS = 4_000;
// A cold local chat model can take several seconds to load before it answers.
// The typed servers are already resident, so they keep the tighter default.
const DEFAULT_CHAT_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_CONFIDENCE = 0.9;
const DEFAULT_MAX_INPUT_CHARS = 12_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const MIN_INPUT_CHARS = 100;
const MAX_INPUT_CHARS = 200_000;

const MODES: readonly DecisionMode[] = ['off', 'shadow', 'triage', 'replace'];
const PROVIDERS: readonly DecisionProviderId[] = ['laya', 'jev', 'chat'];
const FALLBACKS: readonly DecisionFallback[] = ['llm', 'none'];

let cached: Map<DecisionSiteId, DecisionSiteConfig> | null = null;

/** Tests change the env between cases; production parses once per process. */
export function resetDecisionConfigForTests(): void {
  cached = null;
}

/**
 * Global kill switch. The layer is already opt-in per site (no route = off),
 * so the default is enabled; `false`, `0`, and `off` disable every site at
 * once without editing the routes.
 */
export function decisionModelsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DECISION_MODELS_ENABLED?.trim().toLowerCase();
  return !(value === 'false' || value === '0' || value === 'off');
}

function isDecisionSite(value: string): value is DecisionSiteId {
  return (DECISION_SITES as readonly string[]).includes(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
  site: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    log.warn(`Invalid ${label} for decision site "${site}"; using ${fallback}.`);
    return fallback;
  }
  return value;
}

function readHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return value.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function readApiKey(
  entry: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  site: string,
): string | undefined {
  const literal = readString(entry.apiKey);
  if (literal) return literal;
  const envName = readString(entry.apiKeyEnv);
  if (!envName) return undefined;
  const resolved = env[envName]?.trim();
  if (!resolved) {
    log.warn(`Decision site "${site}" references empty apiKeyEnv "${envName}".`);
    return undefined;
  }
  return resolved;
}

/**
 * Parse the whole map. Invalid entries are dropped individually; a malformed
 * JSON document disables the layer with one warning.
 */
export function parseDecisionRoutes(
  raw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Map<DecisionSiteId, DecisionSiteConfig> {
  const configs = new Map<DecisionSiteId, DecisionSiteConfig>();
  if (!raw?.trim()) return configs;
  if (!decisionModelsEnabled(env)) return configs;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.warn('DECISION_ROUTES is not valid JSON; the decision layer is disabled.', error);
    return configs;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn('DECISION_ROUTES must be a JSON object keyed by decision site; ignored.');
    return configs;
  }

  for (const [site, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isDecisionSite(site)) {
      log.warn(`Unknown decision site "${site}" in DECISION_ROUTES; ignored.`);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      log.warn(`Decision site "${site}" must be an object; ignored.`);
      continue;
    }
    const entry = value as Record<string, unknown>;

    const provider = readString(entry.provider)?.toLowerCase() as DecisionProviderId | undefined;
    if (!provider || !PROVIDERS.includes(provider)) {
      log.warn(`Decision site "${site}" needs provider one of ${PROVIDERS.join(', ')}; ignored.`);
      continue;
    }

    // A chat model cannot report calibrated confidence, so `triage` would
    // always fall back. Default it to the permissive mode it can actually
    // drive; an explicit `triage` is still accepted and warned about at boot.
    const defaultMode: DecisionMode = provider === 'chat' ? 'replace' : 'triage';
    const mode = (readString(entry.mode)?.toLowerCase() ?? defaultMode) as DecisionMode;
    if (!MODES.includes(mode)) {
      log.warn(`Decision site "${site}" has invalid mode "${String(entry.mode)}"; ignored.`);
      continue;
    }
    if (mode === 'off') continue;

    // A chat site may omit its model pin and inherit the operator's native
    // DEFAULT_MODEL — the same default generation uses. This keeps decision
    // models on the normal provider/env flow instead of forcing a hardcoded
    // id into every site. An explicit entry.model still wins.
    const model =
      readString(entry.model) ?? (provider === 'chat' ? readString(env.DEFAULT_MODEL) : undefined);
    const endpoint = readHttpUrl(readString(entry.endpoint));
    if (provider === 'chat' && !model) {
      log.warn(
        `Decision site "${site}" provider "chat" needs a model (entry.model or DEFAULT_MODEL); ignored.`,
      );
      continue;
    }
    if (provider !== 'chat' && !endpoint) {
      log.warn(
        `Decision site "${site}" provider "${provider}" requires an http(s) endpoint; ignored.`,
      );
      continue;
    }

    const apiKey = provider === 'chat' ? undefined : readApiKey(entry, env, site);
    const fallback = (readString(entry.fallback)?.toLowerCase() ?? 'llm') as DecisionFallback;
    if (!FALLBACKS.includes(fallback)) {
      log.warn(
        `Decision site "${site}" has invalid fallback "${String(entry.fallback)}"; ignored.`,
      );
      continue;
    }

    let jsonMode = false;
    if (entry.jsonMode !== undefined) {
      if (typeof entry.jsonMode !== 'boolean') {
        log.warn(`Decision site "${site}" has a non-boolean jsonMode; ignored.`);
      } else if (entry.jsonMode && provider !== 'chat') {
        log.warn(
          `Decision site "${site}" sets jsonMode for provider "${provider}"; only chat uses it.`,
        );
      } else {
        jsonMode = entry.jsonMode;
      }
    }

    configs.set(site, {
      site,
      provider,
      mode,
      ...(model ? { model } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(jsonMode ? { jsonMode: true } : {}),
      timeoutMs: readNumber(
        entry.timeoutMs,
        provider === 'chat' ? DEFAULT_CHAT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
        MIN_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
        'timeoutMs',
        site,
      ),
      minConfidence: readNumber(
        entry.minConfidence,
        DEFAULT_MIN_CONFIDENCE,
        0,
        1,
        'minConfidence',
        site,
      ),
      maxInputChars: Math.floor(
        readNumber(
          entry.maxInputChars,
          DEFAULT_MAX_INPUT_CHARS,
          MIN_INPUT_CHARS,
          MAX_INPUT_CHARS,
          'maxInputChars',
          site,
        ),
      ),
      fallback,
    });
  }

  return configs;
}

/**
 * Cached config map for the process. Boot validation warms this cache.
 *
 * The cache is process-wide and reads the process env, matching production
 * behavior. Tests that need a different env should call the pure
 * `parseDecisionRoutes(raw, env)` directly, or reset before changing
 * `process.env`.
 */
export function loadDecisionConfigs(): Map<DecisionSiteId, DecisionSiteConfig> {
  if (!cached) cached = parseDecisionRoutes(process.env.DECISION_ROUTES, process.env);
  return cached;
}

/** Cached config for one site, or undefined when the site is not configured. */
export function getDecisionSiteConfig(site: DecisionSiteId): DecisionSiteConfig | undefined {
  return loadDecisionConfigs().get(site);
}
