import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { callLLM } from '@/lib/ai/llm';
import { getProvider } from '@/lib/ai/providers';
import { apiSuccess } from '@/lib/server/api-response';
import { fetchWithTimeout } from '@/lib/server/fetch-with-timeout';
import { createLogger } from '@/lib/logger';
import {
  enabledServerTTSProviderIds,
  isServerTTSProviderDisabled,
  resolveTTSBaseUrl,
} from '@/lib/server/provider-config';
import { resolveModel } from '@/lib/server/resolve-model';
import type { ProviderId } from '@/lib/types/provider';

/**
 * Stack self-check for operators: runs right after `serve` in one bounded
 * call instead of discovering dead services at generation time (someone's
 * Kokoro process dies, the persistence dir was never created, an API key
 * env was renamed — "the port is up" hides all of it).
 *
 * Cheap checks only, every time:
 * - `persistence` — PERSISTENCE_DIR writability (probe file, deleted);
 * - `llm:<provider>` — key presence for every provider with an API key env
 *   configured (never a real call);
 * - `tts:<provider>` — reachability of each server-configured TTS base URL
 *   (bounded 4s fetch to the root; actually-synthesizing is the TTS route's
 *   job, this only answers "is the service up").
 *
 * The live model round-trip is opt-in (`?live=1`): one call at the resolved
 * default model, 16 output tokens max. Never implicit — dashboards must
 * poll things that don't bill.
 */

export const runtime = 'nodejs';

const log = createLogger('Selfcheck');

export type HealthCheckStatus = 'ok' | 'fail' | 'warn' | 'skipped';

export interface HealthCheckResult {
  id: string;
  status: HealthCheckStatus;
  detail: string;
}

async function checkPersistenceDir(): Promise<HealthCheckResult> {
  const dir = process.env.PERSISTENCE_DIR?.trim();
  if (!dir) {
    return {
      id: 'persistence',
      status: 'skipped',
      detail: 'PERSISTENCE_DIR is not set; document persistence falls back to its default location',
    };
  }
  const probeName = `.selfcheck-probe-${Date.now()}`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, probeName), 'selfcheck', 'utf8');
    await rm(join(dir, probeName), { force: true });
    return { id: 'persistence', status: 'ok', detail: `PERSISTENCE_DIR "${dir}" is writable` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      id: 'persistence',
      status: 'fail',
      detail: `PERSISTENCE_DIR "${dir}" is not writable: ${detail}`,
    };
  }
}

/** Providers that expose an API key env var in the app's catalog. */
function registeredLLMProviderIds(): string[] {
  const ids = [
    'openai',
    'anthropic',
    'google',
    'deepseek',
    'openrouter',
    'grok',
    'glm',
  ];
  return ids.filter((id) => !!getProvider(id as ProviderId));
}

async function checkLLMKey(providerId: string): Promise<HealthCheckResult> {
  const provider = getProvider(providerId as ProviderId);
  if (!provider) {
    return { id: `llm:${providerId}`, status: 'fail', detail: 'not registered in the model catalog' };
  }
  if (!provider.requiresApiKey) {
    return { id: `llm:${providerId}`, status: 'skipped', detail: `${provider.name} is keyless` };
  }
  // Key resolution convention: `<PROVIDER_ID_UPPER>_API_KEY` (LLM_ENV_MAP).
  const apiKey = process.env[`${providerId.toUpperCase()}_API_KEY`]?.trim();
  if (apiKey) {
    return { id: `llm:${providerId}`, status: 'ok', detail: `${provider.name} API key present` };
  }
  return {
    id: `llm:${providerId}`,
    status: 'warn',
    detail: `${provider.name} has no API key configured (${providerId.toUpperCase()}_API_KEY); calls will fail unless the client supplies a key`,
  };
}

async function checkTTS(providerId: string): Promise<HealthCheckResult> {
  const baseUrl = resolveTTSBaseUrl(providerId);
  if (!baseUrl) {
    if (isServerTTSProviderDisabled(providerId)) {
      return { id: `tts:${providerId}`, status: 'skipped', detail: 'disabled server-side' };
    }
    return {
      id: `tts:${providerId}`,
      status: 'warn',
      detail: 'no server base URL to probe (client side resolves this provider)',
    };
  }
  try {
    const response = await fetchWithTimeout(baseUrl, { method: 'GET' }, 4000);
    return {
      id: `tts:${providerId}`,
      status: response.ok ? 'ok' : 'warn',
      detail: `base URL answered HTTP ${response.status}`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      id: `tts:${providerId}`,
      status: 'fail',
      detail: `TTS service unreachable at ${baseUrl}: ${detail}`,
    };
  }
}

async function checkLiveLLM(): Promise<HealthCheckResult> {
  const started = Date.now();
  try {
    const resolved = await resolveModel({ modelString: process.env.DEFAULT_MODEL?.trim() || undefined });
    await callLLM(
      {
        model: resolved.model,
        system: 'You are a health probe. Reply with the single word: ok',
        prompt: 'Reply with: ok',
        maxOutputTokens: 16,
        maxRetries: 0,
      },
      'selfcheck',
      undefined,
      { enabled: false },
    );
    return {
      id: 'llm:live',
      status: 'ok',
      detail: `${resolved.modelString ?? resolved.modelId} responded in ${Date.now() - started}ms`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { id: 'llm:live', status: 'fail', detail: `live LLM call failed: ${detail}` };
  }
}


export async function GET(request: Request): Promise<Response> {
  const live = new URL(request.url).searchParams.get('live') === '1';
  const checks: HealthCheckResult[] = [];

  checks.push(await runGuarded(checkPersistenceDir, 'persistence'));

  for (const providerId of registeredLLMProviderIds()) {
    checks.push(await runGuarded(() => checkLLMKey(providerId as ProviderId), `llm:${providerId}`));
  }

  for (const providerId of enabledServerTTSProviderIds()) {
    checks.push(await runGuarded(() => checkTTS(providerId), `tts:${providerId}`));
  }

  if (live) {
    checks.push(await runGuarded(checkLiveLLM, 'llm:live'));
  }

  const failing = checks.filter((c) => c.status === 'fail');
  return apiSuccess({
    ok: failing.length === 0,
    failureCount: failing.length,
    checks,
  });
}

async function runGuarded(
  check: () => Promise<HealthCheckResult>,
  label: string,
): Promise<HealthCheckResult> {
  try {
    return await check();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`Selfcheck "${label}" internal error: ${detail}`);
    return { id: label, status: 'fail', detail: `selfcheck internal error: ${detail}` };
  }
}

