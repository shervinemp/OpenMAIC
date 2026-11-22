/**
 * Decision-layer telemetry.
 *
 * Counter-only: site, provider, mode, outcome, confidence bucket, latency,
 * and attempt count. Never logs learner text. The counters are process-local
 * and bounded by the number of site/outcome pairs, so they are safe to leave
 * on in production.
 *
 * Shadow counters are aggregated separately so an operator can answer the
 * only question shadow mode exists for: how often does the decision model
 * agree with the LLM? A rate over zero comparable pairs is `null`, never 0%.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('decision');

export type DecisionOutcomeKind =
  | 'decision'
  | 'baseline'
  | 'abstain'
  | 'error'
  | 'skipped'
  | 'shadow-agree'
  | 'shadow-disagree'
  | 'shadow-skip';

export interface DecisionTelemetryEvent {
  site: string;
  provider?: string;
  mode?: string;
  outcome: DecisionOutcomeKind;
  confidence?: number;
  latencyMs?: number;
  /** Wire attempts the adapter made; only reported when greater than one. */
  attempts?: number;
  /** Short machine code, e.g. `timeout`, `no-answer`, `input-too-long`. */
  reason?: string;
}

export interface DecisionTelemetryCounter {
  key: string;
  count: number;
}

export interface ShadowAgreementRow {
  site: string;
  provider: string;
  agree: number;
  disagree: number;
  /** Comparable failures the provider could not produce a value for. */
  skipped: number;
  /** Agree + disagree; the denominator of `agreementRate`. */
  decided: number;
  /** `agree / decided`, or null until at least one comparable pair exists. */
  agreementRate: number | null;
}

export interface DecisionTelemetrySnapshot {
  counters: DecisionTelemetryCounter[];
  shadow: ShadowAgreementRow[];
}

interface ShadowAccumulator {
  site: string;
  provider: string;
  agree: number;
  disagree: number;
  skipped: number;
}

const counters = new Map<string, number>();
const shadowCounters = new Map<string, ShadowAccumulator>();

function counterKey(event: DecisionTelemetryEvent): string {
  return `${event.site}|${event.provider ?? '-'}|${event.mode ?? '-'}|${event.outcome}`;
}

function shadowKey(site: string, provider: string): string {
  // NUL cannot appear in a site id or an adapter label; a printable separator
  // would be ambiguous if either eventually contains one.
  return `${site}\u0000${provider}`;
}

function recordShadowOutcome(event: DecisionTelemetryEvent): void {
  // In shadow mode a provider error or an abstain is a comparable failure the
  // provider could not answer — count it as skipped, not as invisible.
  const outcome =
    event.mode === 'shadow' && (event.outcome === 'error' || event.outcome === 'abstain')
      ? 'shadow-skip'
      : event.outcome;
  if (
    outcome !== 'shadow-agree' &&
    outcome !== 'shadow-disagree' &&
    outcome !== 'shadow-skip'
  ) {
    return;
  }
  const provider = event.provider ?? '-';
  const key = shadowKey(event.site, provider);
  let row = shadowCounters.get(key);
  if (!row) {
    row = { site: event.site, provider, agree: 0, disagree: 0, skipped: 0 };
    shadowCounters.set(key, row);
  }
  if (outcome === 'shadow-agree') row.agree += 1;
  else if (outcome === 'shadow-disagree') row.disagree += 1;
  else row.skipped += 1;
}

export function recordDecisionEvent(event: DecisionTelemetryEvent): void {
  const key = counterKey(event);
  counters.set(key, (counters.get(key) ?? 0) + 1);
  recordShadowOutcome(event);

  const parts = [
    `site=${event.site}`,
    `outcome=${event.outcome}`,
    event.provider ? `provider=${event.provider}` : undefined,
    event.mode ? `mode=${event.mode}` : undefined,
    typeof event.confidence === 'number' ? `confidence=${event.confidence.toFixed(3)}` : undefined,
    typeof event.latencyMs === 'number' ? `latency=${Math.round(event.latencyMs)}ms` : undefined,
    typeof event.attempts === 'number' && event.attempts > 1
      ? `attempts=${event.attempts}`
      : undefined,
    event.reason ? `reason=${event.reason}` : undefined,
  ].filter((part): part is string => part !== undefined);

  log.info(parts.join(' '));
}

/** Sorted counters for tests and operator diagnostics. */
export function readDecisionTelemetry(): DecisionTelemetryCounter[] {
  return [...counters.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => ({ key, count }));
}

/** Shadow agreement per site/provider, sorted for stable diagnostics output. */
export function readShadowAgreement(): ShadowAgreementRow[] {
  return [...shadowCounters.values()]
    .map((row) => {
      const decided = row.agree + row.disagree;
      return {
        ...row,
        decided,
        agreementRate: decided === 0 ? null : row.agree / decided,
      };
    })
    .sort((a, b) =>
      a.site === b.site ? a.provider.localeCompare(b.provider) : a.site.localeCompare(b.site),
    );
}

/** Everything the diagnostics surface needs in one call. */
export function snapshotDecisionTelemetry(): DecisionTelemetrySnapshot {
  return {
    counters: readDecisionTelemetry(),
    shadow: readShadowAgreement(),
  };
}

function positiveCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge a persisted snapshot into the live counters. Used once at boot by the
 * best-effort file sink; malformed rows are ignored rather than rejecting the
 * whole file. Rates are recomputed from the summed counts, so a stale rate in
 * the file cannot win over the raw numbers.
 */
export function mergeDecisionTelemetry(snapshot: unknown): void {
  if (!isRecord(snapshot)) return;

  if (Array.isArray(snapshot.counters)) {
    for (const entry of snapshot.counters) {
      if (!isRecord(entry) || typeof entry.key !== 'string') continue;
      const count = positiveCount(entry.count);
      if (count === 0) continue;
      counters.set(entry.key, (counters.get(entry.key) ?? 0) + count);
    }
  }

  if (Array.isArray(snapshot.shadow)) {
    for (const entry of snapshot.shadow) {
      if (!isRecord(entry) || typeof entry.site !== 'string') continue;
      const provider = typeof entry.provider === 'string' ? entry.provider : '-';
      const key = shadowKey(entry.site, provider);
      const row = shadowCounters.get(key) ?? {
        site: entry.site,
        provider,
        agree: 0,
        disagree: 0,
        skipped: 0,
      };
      row.agree += positiveCount(entry.agree);
      row.disagree += positiveCount(entry.disagree);
      row.skipped += positiveCount(entry.skipped);
      shadowCounters.set(key, row);
    }
  }
}

export function resetDecisionTelemetryForTests(): void {
  counters.clear();
  shadowCounters.clear();
}
