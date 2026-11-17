/**
 * The decision-layer router: mode handling, fallback, and telemetry.
 *
 * Every site calls this with the same pieces: a typed request, the existing
 * LLM implementation as `baseline`, and a mapper from decision answers to the
 * site's value. The router is the only place that knows about modes, timeouts,
 * confidence thresholds, and the kill switch, so sites cannot drift.
 */

import { getDecisionSiteConfig } from './config';
import { createChatDecisionProvider } from './providers/chat';
import { createTypedHttpProvider } from './providers/laya';
import { recordDecisionEvent } from './telemetry';
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  DecisionSiteConfig,
  DecisionSiteId,
} from './types';

export interface DecisionRunInput<T> {
  site: DecisionSiteId;
  /** Total characters the decision model would see. > maxInputChars = skip. */
  inputChars: number;
  request: DecisionRequest;
  /** The current LLM implementation. Omitted when the site has no LLM path. */
  baseline?: () => Promise<T>;
  /**
   * Map a provider result to the site's value. Return null when the result is
   * incomplete or unusable; the router then falls back.
   */
  fromResult: (
    result: DecisionResult,
    config: DecisionSiteConfig,
  ) => { value: T; confidence: number } | null;
  /** Shadow-mode comparison. `undefined` means "not comparable". */
  compare?: (decision: T, baseline: T) => boolean | undefined;
  signal?: AbortSignal;
}

/** Test seam: inject a provider and/or config instead of reading the env. */
export interface DecisionRunDeps {
  provider?: DecisionProvider;
  config?: DecisionSiteConfig;
}

export type DecisionRunOutcome<T> =
  | { source: 'decision'; value: T; confidence: number }
  | { source: 'baseline'; value: T }
  | { source: 'none'; reason: string };

function providerFor(config: DecisionSiteConfig, deps: DecisionRunDeps): DecisionProvider {
  if (deps.provider) return deps.provider;
  return config.provider === 'chat'
    ? createChatDecisionProvider(config)
    : createTypedHttpProvider(config);
}

function safeFromResult<T>(
  input: DecisionRunInput<T>,
  result: DecisionResult,
  config: DecisionSiteConfig,
): { value: T; confidence: number } | null {
  try {
    return input.fromResult(result, config);
  } catch {
    return null;
  }
}

/** A broken comparator must not fail a shadowed learner request. */
function safeCompare<T>(input: DecisionRunInput<T>, decision: T, baseline: T): boolean | undefined {
  try {
    return input.compare?.(decision, baseline);
  } catch {
    return undefined;
  }
}

async function fallback<T>(
  input: DecisionRunInput<T>,
  config: DecisionSiteConfig,
  reason: string,
): Promise<DecisionRunOutcome<T>> {
  if (config.fallback === 'none' || !input.baseline) {
    return { source: 'none', reason };
  }
  return { source: 'baseline', value: await input.baseline() };
}

async function runProvider<T>(
  provider: DecisionProvider,
  input: DecisionRunInput<T>,
  config: DecisionSiteConfig,
): Promise<DecisionResult | null> {
  try {
    return await provider.decide(input.request, input.signal);
  } catch (error) {
    recordDecisionEvent({
      site: input.site,
      provider: provider.id,
      mode: config.mode,
      outcome: 'error',
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * Run one decision site.
 *
 * - no config / `off`  → baseline, unchanged
 * - `shadow`           → run both, log agreement, return baseline
 * - `triage`           → decision only above `minConfidence`, else baseline
 * - `replace`          → any usable decision, else baseline
 *
 * A decision failure never throws. A baseline failure is rethrown so the
 * route's existing error handling still applies.
 */
export async function runDecisionSite<T>(
  input: DecisionRunInput<T>,
  deps: DecisionRunDeps = {},
): Promise<DecisionRunOutcome<T>> {
  const config = deps.config ?? getDecisionSiteConfig(input.site);
  if (!config || config.mode === 'off') {
    if (!input.baseline) return { source: 'none', reason: 'not-configured' };
    return { source: 'baseline', value: await input.baseline() };
  }

  if (input.inputChars > config.maxInputChars) {
    recordDecisionEvent({
      site: input.site,
      provider: deps.provider?.id ?? config.provider,
      mode: config.mode,
      outcome: 'skipped',
      reason: 'input-too-long',
    });
    return fallback(input, config, 'input-too-long');
  }

  if (input.request.questions.length === 0) {
    recordDecisionEvent({
      site: input.site,
      provider: deps.provider?.id ?? config.provider,
      mode: config.mode,
      outcome: 'skipped',
      reason: 'no-questions',
    });
    return fallback(input, config, 'no-questions');
  }

  // A chat model's confidence is self-reported, not calibrated. `triage` would
  // always fall back after paying for the call, so skip the call entirely and
  // let the boot warning point the operator at `replace` or `shadow`.
  if (config.mode === 'triage' && config.provider === 'chat') {
    recordDecisionEvent({
      site: input.site,
      provider: deps.provider?.id ?? config.provider,
      mode: config.mode,
      outcome: 'skipped',
      reason: 'uncalibrated',
    });
    return fallback(input, config, 'uncalibrated');
  }

  let provider: DecisionProvider;
  try {
    provider = providerFor(config, deps);
  } catch {
    // A malformed injected config or a missing endpoint must fall back, not
    // fail the learner request. Env parsing normally catches this earlier.
    recordDecisionEvent({
      site: input.site,
      provider: config.provider,
      mode: config.mode,
      outcome: 'error',
      reason: 'provider-config',
    });
    return fallback(input, config, 'provider-config');
  }

  if (config.mode === 'shadow') {
    // Shadow is a validation mode, not a hot path. Without a baseline there is
    // nothing to compare, so skip the extra call entirely.
    if (!input.baseline) {
      recordDecisionEvent({
        site: input.site,
        provider: provider.id,
        mode: config.mode,
        outcome: 'shadow-skip',
        reason: 'no-baseline',
      });
      return { source: 'none', reason: 'no-baseline' };
    }

    const [decisionSettled, baselineSettled] = await Promise.allSettled([
      provider.decide(input.request, input.signal),
      input.baseline(),
    ]);

    if (baselineSettled.status === 'rejected') throw baselineSettled.reason;
    const baselineValue = baselineSettled.value;

    if (decisionSettled.status === 'rejected') {
      recordDecisionEvent({
        site: input.site,
        provider: provider.id,
        mode: config.mode,
        outcome: 'error',
        reason: decisionSettled.reason instanceof Error ? decisionSettled.reason.name : 'unknown',
      });
      return { source: 'baseline', value: baselineValue };
    }

    const result = decisionSettled.value;
    const mapped = safeFromResult(input, result, config);
    if (!mapped) {
      recordDecisionEvent({
        site: input.site,
        provider: provider.id,
        mode: config.mode,
        outcome: 'abstain',
        reason: 'no-answer',
        latencyMs: result.latencyMs,
      });
      return { source: 'baseline', value: baselineValue };
    }

    const agreement = safeCompare(input, mapped.value, baselineValue);
    recordDecisionEvent({
      site: input.site,
      provider: provider.id,
      mode: config.mode,
      outcome:
        agreement === true
          ? 'shadow-agree'
          : agreement === false
            ? 'shadow-disagree'
            : 'shadow-skip',
      confidence: mapped.confidence,
      latencyMs: result.latencyMs,
    });
    return { source: 'baseline', value: baselineValue };
  }

  const result = await runProvider(provider, input, config);
  if (!result) return fallback(input, config, 'provider-error');

  const mapped = safeFromResult(input, result, config);
  if (!mapped) {
    recordDecisionEvent({
      site: input.site,
      provider: provider.id,
      mode: config.mode,
      outcome: 'abstain',
      reason: 'no-answer',
      latencyMs: result.latencyMs,
    });
    return fallback(input, config, 'no-answer');
  }

  if (config.mode === 'triage' && mapped.confidence < config.minConfidence) {
    recordDecisionEvent({
      site: input.site,
      provider: provider.id,
      mode: config.mode,
      outcome: 'abstain',
      reason: 'low-confidence',
      confidence: mapped.confidence,
      latencyMs: result.latencyMs,
    });
    return fallback(input, config, 'low-confidence');
  }

  recordDecisionEvent({
    site: input.site,
    provider: provider.id,
    mode: config.mode,
    outcome: 'decision',
    confidence: mapped.confidence,
    latencyMs: result.latencyMs,
  });
  return { source: 'decision', value: mapped.value, confidence: mapped.confidence };
}
