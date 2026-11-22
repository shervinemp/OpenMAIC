/**
 * The single System 1 choice, sent as headers from Settings and used for every
 * decision site. There is no separate server-side decision config: no header,
 * no decision call — the site keeps its normal LLM baseline.
 */

import { parseModelString, PROVIDERS } from '@/lib/ai/providers';
import { validateClientBaseUrl } from '@/lib/server/ssrf-guard';
import type { DecisionMode, DecisionSiteConfig, DecisionSiteId } from './types';

export const DECISION_HEADERS = {
  enabled: 'x-decision-enabled',
  provider: 'x-decision-provider',
  model: 'x-decision-model',
  endpoint: 'x-decision-endpoint',
  mode: 'x-decision-mode',
} as const;

function modeFromRequest(req: Request): DecisionMode {
  const raw = req.headers.get(DECISION_HEADERS.mode)?.trim().toLowerCase();
  return raw === 'replace' ? 'replace' : 'shadow';
}

/**
 * Build the one decision config from request headers. Never throws.
 *
 * The typed endpoint is client-supplied, so it goes through the same SSRF
 * policy as other client-influenced base URLs before the server fetches it.
 */
export async function decisionConfigFromRequest(
  req: Request,
  site: DecisionSiteId,
): Promise<DecisionSiteConfig | undefined> {
  if (req.headers.get(DECISION_HEADERS.enabled) !== '1') return undefined;

  const provider = req.headers.get(DECISION_HEADERS.provider)?.trim().toLowerCase() || 'chat';
  const common = {
    site,
    mode: modeFromRequest(req),
    fallback: 'llm' as const,
    timeoutMs: 15_000,
    minConfidence: 0.9,
    maxInputChars: 12_000,
  };

  if (provider === 'laya' || provider === 'jev') {
    const endpoint = req.headers.get(DECISION_HEADERS.endpoint)?.trim();
    if (!endpoint) return undefined;
    if (await validateClientBaseUrl(endpoint)) return undefined;
    return { ...common, provider, endpoint };
  }

  const model = req.headers.get(DECISION_HEADERS.model)?.trim();
  if (!model) return undefined;
  // Require an explicit provider:model pair; a bare id would silently default
  // to OpenAI and pick a different model than the user chose in Settings.
  const colon = model.indexOf(':');
  if (colon <= 0 || colon === model.length - 1) return undefined;
  try {
    const { providerId, modelId } = parseModelString(model);
    if (!providerId || !modelId || !(providerId in PROVIDERS)) return undefined;
  } catch {
    return undefined;
  }
  return { ...common, provider: 'chat', model };
}
