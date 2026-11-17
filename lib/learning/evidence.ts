/**
 * The bounded, idempotent evidence log.
 *
 * Producers retry: a quiz submit can be replayed, an activity check can be
 * polled twice, a background pass can resume. An evidence id is therefore an
 * idempotency key, and the first write wins. The log is bounded because it
 * lives in a course document or a learner partition, not a warehouse; dropping
 * the oldest observations is preferable to growing a course file without
 * limit. The cap is generous enough that mastery over a course is stable, and
 * it is a parameter so a host with different storage can choose its own.
 *
 * Validation is deliberately defensive. Imported classrooms and hand-edited
 * documents are untrusted input, and a malformed record must be dropped rather
 * than folded into a learner's mastery as a wrong answer.
 */

import type { ConceptId, LearningEvidence, LearningEvidenceSource } from './types';

export const DEFAULT_EVIDENCE_LIMIT = 5000;

/** Keep one record from claiming an unbounded share of a posterior. */
const MAX_EVIDENCE_WEIGHT = 4;

/** Keep a single item's tag list finite when a model over-produces. */
const MAX_CONCEPTS_PER_ITEM = 16;

const SOURCES: ReadonlySet<LearningEvidenceSource> = new Set([
  'quiz',
  'exam',
  'activity',
  'pbl',
  'review',
]);

function cleanId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanConceptIds(value: unknown): ConceptId[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ConceptId>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const conceptId = entry.trim();
    if (conceptId.length === 0 || seen.has(conceptId)) continue;
    seen.add(conceptId);
    if (seen.size >= MAX_CONCEPTS_PER_ITEM) break;
  }
  return [...seen];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Normalize one untrusted record, or return `null` when it carries no usable
 * observation. Ids are trimmed, concept tags are deduplicated, the score is
 * clamped to 0..1, and an `ungraded` record carries no score at all.
 */
export function normalizeEvidence(value: unknown): LearningEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<LearningEvidence>;

  const id = cleanId(record.id);
  const learnerKey = cleanId(record.learnerKey);
  const stageId = cleanId(record.stageId);
  const itemId = cleanId(record.itemId);
  if (!id || !learnerKey || !stageId || !itemId) return null;

  const source = record.source;
  if (typeof source !== 'string' || !SOURCES.has(source as LearningEvidenceSource)) return null;

  const outcome = record.outcome;
  if (outcome !== 'graded' && outcome !== 'ungraded') return null;

  const recordedAt = record.recordedAt;
  if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt) || recordedAt < 0) {
    return null;
  }

  // An ungraded record has no score by definition; a graded one must carry one.
  const rawScore = record.score;
  if (outcome === 'graded' && (typeof rawScore !== 'number' || !Number.isFinite(rawScore))) {
    return null;
  }

  const weight = record.weight;
  const normalizedWeight =
    typeof weight === 'number' && Number.isFinite(weight) && weight > 0
      ? Math.min(MAX_EVIDENCE_WEIGHT, weight)
      : undefined;

  return {
    id,
    learnerKey,
    stageId,
    itemId,
    conceptIds: cleanConceptIds(record.conceptIds),
    source: source as LearningEvidenceSource,
    score: outcome === 'ungraded' ? 0 : clamp01(typeof rawScore === 'number' ? rawScore : 0),
    outcome,
    recordedAt,
    ...(normalizedWeight === undefined ? {} : { weight: normalizedWeight }),
  };
}

function normalizedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_EVIDENCE_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_EVIDENCE_LIMIT;
  return Math.max(1, Math.floor(limit));
}

/**
 * Append one record to a log.
 *
 * Returns the input array unchanged when the record is invalid or its id is
 * already present. Trimming keeps insertion order; it selects the oldest
 * records by timestamp (insertion order breaks ties) and drops exactly the
 * overflow.
 */
export function appendEvidence(
  log: readonly LearningEvidence[],
  value: unknown,
  options: { limit?: number } = {},
): readonly LearningEvidence[] {
  const evidence = normalizeEvidence(value);
  if (!evidence) return log;
  if (log.some((existing) => existing.id === evidence.id)) return log;

  const next = [...log, evidence];
  const limit = normalizedLimit(options.limit);
  const overflow = next.length - limit;
  if (overflow <= 0) return next;

  const drop = new Set(
    next
      .map((record, index) => ({ record, index }))
      .sort((a, b) => a.record.recordedAt - b.record.recordedAt || a.index - b.index)
      .slice(0, overflow)
      .map((entry) => entry.index),
  );
  return next.filter((_, index) => !drop.has(index));
}

/** Whether an id is already recorded. */
export function hasEvidence(log: readonly LearningEvidence[], id: string): boolean {
  return log.some((record) => record.id === id);
}
