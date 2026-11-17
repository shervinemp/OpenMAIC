/**
 * Connectivity probe for configured decision sites.
 *
 * The probe answers one operator question: "is the decision server reachable
 * with the current config?" It sends a fixed, learner-free `noul` question and
 * only inspects whether the adapter produced a usable result. Probe traffic is
 * deliberately kept out of the router and therefore out of the shadow
 * agreement counters, so a health check cannot flatter the statistics.
 *
 * Chat sites are reported as configured rather than called: probing one would
 * spend a real model call and tell the operator less than the first real
 * decision request will.
 */

import { loadDecisionConfigs } from './config';
import { createTypedHttpProvider } from './providers/laya';
import type {
  DecisionMode,
  DecisionProvider,
  DecisionProviderId,
  DecisionRequest,
  DecisionSiteConfig,
  DecisionSiteId,
} from './types';

export type DecisionProbeStatus = 'ok' | 'configured' | 'error';

export interface DecisionSiteProbe {
  site: DecisionSiteId;
  provider: DecisionProviderId;
  mode: DecisionMode;
  status: DecisionProbeStatus;
  latencyMs?: number;
  /** Short diagnostic; never contains a response body or learner text. */
  detail?: string;
}

export interface ProbeDecisionSitesOptions {
  /** Test seam; defaults to the process config. */
  configs?: ReadonlyMap<DecisionSiteId, DecisionSiteConfig>;
  /** Test seam; production constructs the real typed adapter. */
  createProvider?: (config: DecisionSiteConfig) => DecisionProvider;
  signal?: AbortSignal;
}

const PROBE_REQUEST: DecisionRequest = {
  state: 'OpenMAIC decision-layer connectivity probe. This request contains no learner data.',
  questions: [
    {
      id: 'probe',
      kind: 'noul',
      prompt: 'Return probability 0.5 confidence 0.5 to acknowledge this connectivity probe.',
    },
  ],
};

async function probeTypedSite(
  config: DecisionSiteConfig,
  options: ProbeDecisionSitesOptions,
): Promise<DecisionSiteProbe> {
  const startedAt = Date.now();
  try {
    const provider =
      options.createProvider?.(config) ?? createTypedHttpProvider(config, { retryDelayMs: 0 });
    const result = await provider.decide(PROBE_REQUEST, options.signal);
    return {
      site: config.site,
      provider: config.provider,
      mode: config.mode,
      status: 'ok',
      latencyMs: result.latencyMs || Date.now() - startedAt,
      detail: result.answers.has('probe')
        ? 'answer received'
        : result.abstained.has('probe')
          ? 'server abstained'
          : 'server responded',
    };
  } catch (error) {
    return {
      site: config.site,
      provider: config.provider,
      mode: config.mode,
      status: 'error',
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : 'probe failed',
    };
  }
}

/** Probe every configured site in parallel; preserves config order. */
export async function probeDecisionSites(
  options: ProbeDecisionSitesOptions = {},
): Promise<DecisionSiteProbe[]> {
  const configs = options.configs ?? loadDecisionConfigs();
  return Promise.all(
    [...configs.values()].map((config) =>
      config.provider === 'chat'
        ? Promise.resolve<DecisionSiteProbe>({
            site: config.site,
            provider: config.provider,
            mode: config.mode,
            status: 'configured',
            detail: 'chat model; probed by the first real decision call',
          })
        : probeTypedSite(config, options),
    ),
  );
}
