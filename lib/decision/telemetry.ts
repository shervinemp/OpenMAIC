/**
 * Decision-layer telemetry.
 *
 * Counter-only: site, provider, mode, outcome, confidence bucket, latency.
 * Never logs learner text. The counters are process-local and bounded by the
 * number of site/outcome pairs, so they are safe to leave on in production.
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
  /** Short machine code, e.g. `timeout`, `no-answer`, `input-too-long`. */
  reason?: string;
}

const counters = new Map<string, number>();

function counterKey(event: DecisionTelemetryEvent): string {
  return `${event.site}|${event.provider ?? '-'}|${event.mode ?? '-'}|${event.outcome}`;
}

export function recordDecisionEvent(event: DecisionTelemetryEvent): void {
  const key = counterKey(event);
  counters.set(key, (counters.get(key) ?? 0) + 1);

  const parts = [
    `site=${event.site}`,
    `outcome=${event.outcome}`,
    event.provider ? `provider=${event.provider}` : undefined,
    event.mode ? `mode=${event.mode}` : undefined,
    typeof event.confidence === 'number' ? `confidence=${event.confidence.toFixed(3)}` : undefined,
    typeof event.latencyMs === 'number' ? `latency=${Math.round(event.latencyMs)}ms` : undefined,
    event.reason ? `reason=${event.reason}` : undefined,
  ].filter((part): part is string => part !== undefined);

  log.info(parts.join(' '));
}

/** Sorted counters for tests and operator diagnostics. */
export function readDecisionTelemetry(): Array<{ key: string; count: number }> {
  return [...counters.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => ({ key, count }));
}

export function resetDecisionTelemetryForTests(): void {
  counters.clear();
}
