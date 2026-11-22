/**
 * Per-request decision model override from the opt-in Settings choice.
 *
 * A browser picks exactly ONE `provider:model` string in Settings. That single
 * choice is sent as headers on the sites that use the decision layer. It wins
 * over the server's DECISION_ROUTES for that request only; with no valid header
 * the site keeps its server config, and with neither config the router falls
 * back to the site's LLM baseline.
 */

import { parseModelString } from '@/lib/ai/providers';
import type { DecisionMode, DecisionSiteConfig, DecisionSiteId } from './types';

export const DECISION_HEADERS = {
  enabled: 'x-decision-enabled',
  model: 'x-decision-model',
  mode: 'x-decision-mode',
} as const;

/**
 * Build a chat decision config from request headers. Returns undefined when
 * the user has not opted in or sent an invalid model string — never throws.
 */
export function decisionConfigFromRequest(
  req: Request,
  site: DecisionSiteId,
): DecisionSiteConfig | undefined {
  if (req.headers.get(DECISION_HEADERS.enabled) !== '1') return undefined;
  const model = req.headers.get(DECISION_HEADERS.model)?.trim();
  if (!model) return undefined;
  // Require an explicit provider:model pair; a bare id would silently default
  // to OpenAI and pick a different model than the user chose in Settings.
  const colon = model.indexOf(':');
  if (colon <= 0 || colon === model.length - 1) return undefined;

  try {
    const { providerId, modelId } = parseModelString(model);
    if (!providerId || !modelId) return undefined;
  } catch {
    return undefined;
  }

  const modeHeader = req.headers.get(DECISION_HEADERS.mode)?.trim().toLowerCase();
  const mode: DecisionMode = modeHeader === 'replace' ? 'replace' : 'shadow';

  return {
    site,
    provider: 'chat',
    model,
    mode,
    fallback: 'llm',
    timeoutMs: 15_000,
    minConfidence: 0.9,
    maxInputChars: 12_000,
  };
}
