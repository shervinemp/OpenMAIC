/**
 * Stored shape of the learning log and the fold that reads it back.
 *
 * The runtime store is append-only, so the learner partition holds two kinds
 * of record: one evidence observation, and an occasional review-card snapshot.
 * Reading is order-sensitive for evidence (first write wins) and last-write-
 * wins per card, which is exactly what a map merge gives us. Keeping the fold
 * here, pure and independent of RuntimeStore, lets the storage layer stay a
 * thin I/O wrapper and lets tests pin the merge rules without IndexedDB.
 */

import { appendEvidence, normalizeEvidence } from './evidence';
import { normalizeReviewCard } from './review';
import type { LearningEvidence, ReviewCard } from './types';

export const LEARNING_PAYLOAD_VERSION = 1;

export type LearningRecordPayload =
  | {
      version: typeof LEARNING_PAYLOAD_VERSION;
      kind: 'evidence';
      evidence: LearningEvidence;
    }
  | {
      version: typeof LEARNING_PAYLOAD_VERSION;
      kind: 'reviewCards';
      cards: ReviewCard[];
    };

export interface LearningState {
  evidence: LearningEvidence[];
  reviewCards: ReviewCard[];
}

export interface FoldLearningRecordsOptions {
  /** Evidence window used by the fold. Defaults to the log's own limit. */
  evidenceLimit?: number;
}

/**
 * Validate and normalize one stored payload. Unknown versions and malformed
 * observations are skipped rather than trusted; a corrupted row must not move
 * a learner's mastery or schedule a card for the wrong day.
 */
export function normalizeLearningPayload(value: unknown): LearningRecordPayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Record<string, unknown>;
  if (payload.version !== LEARNING_PAYLOAD_VERSION) return null;

  if (payload.kind === 'evidence') {
    const evidence = normalizeEvidence(payload.evidence);
    if (!evidence) return null;
    return {
      version: LEARNING_PAYLOAD_VERSION,
      kind: 'evidence',
      evidence,
    };
  }

  if (payload.kind === 'reviewCards') {
    if (!Array.isArray(payload.cards)) return null;
    const cards: ReviewCard[] = [];
    for (const entry of payload.cards) {
      const card = normalizeReviewCard(entry);
      if (card) cards.push(card);
    }
    if (cards.length === 0) return null;
    return {
      version: LEARNING_PAYLOAD_VERSION,
      kind: 'reviewCards',
      cards,
    };
  }

  return null;
}

function compareCards(a: ReviewCard, b: ReviewCard): number {
  if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
  return a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0;
}

/**
 * Fold every record in append order.
 *
 * Evidence uses the log's own idempotent append, so a replay is harmless. Card
 * snapshots merge per card: a later snapshot for one card does not erase a
 * different card written by another tab.
 */
export function foldLearningRecords(
  records: readonly { payload: unknown }[],
  options: FoldLearningRecordsOptions = {},
): LearningState {
  let evidence: readonly LearningEvidence[] = [];
  const cards = new Map<string, ReviewCard>();

  for (const record of records) {
    const payload = normalizeLearningPayload(record.payload);
    if (!payload) continue;
    if (payload.kind === 'evidence') {
      evidence = appendEvidence(evidence, payload.evidence, { limit: options.evidenceLimit });
      continue;
    }
    for (const card of payload.cards) cards.set(card.cardId, card);
  }

  return {
    evidence: [...evidence],
    reviewCards: [...cards.values()].sort(compareCards),
  };
}
