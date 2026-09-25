import type { SceneContentFailure } from '@openmaic/generation';

/**
 * Per-scene generation failure ledger (in-process side channel).
 *
 * When a scene's content generation fails, the pipeline knows far more than
 * the generic "Failed to generate content" line it currently reports: the
 * failure code the scene type raised, the depth findings on corrective-loop
 * exhaustion, the model that failed. This ledger carries those details from
 * the generation call to the point of response assembly (and to any
 * diagnostics surface) with the same take-once semantics as the depth
 * side channels in @openmaic/generation.
 *
 * Scope note: in-memory per server process, bounded. It intentionally does not
 * persist — a crashed dev server already resurfaces every failure through the
 * client's failed-outline cards, and cross-process durability would drag in a
 * storage seam decision (SQL/JSON) that belongs to the agent-runtime leases,
 * not to a request-scoped diagnostic channel.
 */

export interface SceneFailureRecord extends SceneContentFailure {
  outlineId: string;
  outlineTitle: string;
  sceneType: string;
  /** Resolved model string, e.g. "deepseek:deepseek-flash" (when known). */
  model?: string;
  /** Depth/validator findings from corrective-loop exhaustion, if any. */
  findings?: string[];
  at: number;
}

const LEDGER_CAPACITY = 256;

const ledger = new Map<string, SceneFailureRecord>();

export function recordSceneFailure(record: SceneFailureRecord): void {
  const outlineId = record.outlineId;
  // Drop the oldest record when the newest outline would push past capacity
  // (Map preserves insertion order; the ring holds at most one record per
  // outline id).
  while (ledger.size >= LEDGER_CAPACITY && !ledger.has(outlineId)) {
    const oldest = ledger.keys().next().value;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }
  ledger.set(outlineId, record);
}

export function takeSceneFailure(outlineId: string): SceneFailureRecord | undefined {
  const record = ledger.get(outlineId);
  if (record) ledger.delete(outlineId);
  return record;
}

/** Diagnostics snapshot (does not consume records). Newest first. */
export function snapshotSceneFailures(): SceneFailureRecord[] {
  return [...ledger.values()].sort((a, b) => b.at - a.at);
}

/** Reset for tests. */
export function resetSceneFailureLedgerForTests(): void {
  ledger.clear();
}

const FAILURE_CODE_LABELS: Record<SceneContentFailure['code'], string> = {
  'prompt-unavailable': 'the scene prompt template is missing (buildPrompt returned nothing)',
  'invalid-model-output': 'the model output could not be parsed into the scene schema',
};

/**
 * Human-facing reason line for a failed scene, consumer-ready as the
 * suffix of the GENERATION_FAILED API error.
 */
export function describeSceneFailure(record: SceneFailureRecord | undefined): string | undefined {
  if (!record) return undefined;
  const base = FAILURE_CODE_LABELS[record.code] ?? `generation failure (${record.code})`;
  const findings = record.findings?.length ? ` — findings: ${record.findings.join('; ')}` : '';
  return `${base}${findings}`;
}
