import { describe, expect, it } from 'vitest';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { foldLearningRecords, normalizeLearningPayload } from '@/lib/learning/store-payload';
import type { LearningEvidence, ReviewCard } from '@/lib/learning/types';

function evidence(overrides: Partial<LearningEvidence> = {}): LearningEvidence {
  return {
    id: 'evt_1',
    learnerKey: 'learner-1',
    stageId: 'stage-1',
    itemId: 'q1',
    conceptIds: ['recursion'],
    source: 'quiz',
    score: 1,
    outcome: 'graded',
    recordedAt: 1_000,
    ...overrides,
  };
}

function card(overrides: Partial<ReviewCard> = {}): ReviewCard {
  return {
    cardId: 'stage-1:scene-1:q1',
    conceptIds: ['recursion'],
    ease: 2.5,
    intervalDays: 0,
    repetitions: 0,
    lapses: 0,
    dueAt: 1_000,
    ...overrides,
  };
}

function evidenceRecord(value: LearningEvidence) {
  return { payload: { version: 1, kind: 'evidence', evidence: value } };
}

function cardsRecord(cards: ReviewCard[]) {
  return { payload: { version: 1, kind: 'reviewCards', cards } };
}

describe('learning record payload', () => {
  it('normalizes evidence and rejects unknown versions', () => {
    expect(normalizeLearningPayload(evidenceRecord(evidence()).payload)).toMatchObject({
      kind: 'evidence',
      evidence: { id: 'evt_1', score: 1 },
    });
    expect(
      normalizeLearningPayload({ version: 2, kind: 'evidence', evidence: evidence() }),
    ).toBeNull();
    expect(normalizeLearningPayload({ version: 1, kind: 'unknown' })).toBeNull();
    expect(normalizeLearningPayload(null)).toBeNull();
  });

  it('skips a malformed observation instead of folding a wrong answer', () => {
    expect(
      normalizeLearningPayload({
        version: 1,
        kind: 'evidence',
        evidence: evidence({ score: Number.NaN }),
      }),
    ).toBeNull();
  });

  it('drops malformed cards and rejects an all-invalid snapshot', () => {
    const good = card();
    const payload = normalizeLearningPayload(
      cardsRecord([good, { ...card({ cardId: 'broken' }), dueAt: Number.NaN } as ReviewCard])
        .payload,
    );
    expect(payload).toMatchObject({ kind: 'reviewCards', cards: [good] });

    expect(
      normalizeLearningPayload(cardsRecord([{ ...good, dueAt: Number.NaN } as ReviewCard]).payload),
    ).toBeNull();
  });

  it('is registered as a runtime payload validator', () => {
    expect(APP_RUNTIME_PAYLOAD_VALIDATORS.learning(evidenceRecord(evidence()).payload)).toEqual({
      valid: true,
    });
    expect(APP_RUNTIME_PAYLOAD_VALIDATORS.learning({ version: 1, kind: 'evidence' })).toMatchObject(
      { valid: false },
    );
  });
});

describe('learning record fold', () => {
  it('folds evidence idempotently in append order', () => {
    const state = foldLearningRecords([
      evidenceRecord(evidence({ id: 'a', score: 0, recordedAt: 10 })),
      evidenceRecord(evidence({ id: 'b', score: 1, recordedAt: 20 })),
      evidenceRecord(evidence({ id: 'a', score: 1, recordedAt: 30 })),
      { payload: { version: 1, kind: 'evidence', evidence: evidence({ id: '' }) } },
    ]);

    expect(state.evidence.map((record) => record.id)).toEqual(['a', 'b']);
    expect(state.evidence[0].score).toBe(0);
  });

  it('merges card snapshots per card instead of replacing the whole set', () => {
    const first = card({ cardId: 'card-a', dueAt: 10 });
    const second = card({ cardId: 'card-b', dueAt: 20 });
    const updated = card({ cardId: 'card-a', dueAt: 99, repetitions: 2 });

    const state = foldLearningRecords([
      cardsRecord([first]),
      cardsRecord([second]),
      cardsRecord([updated]),
    ]);

    expect(state.reviewCards).toEqual([
      card({ cardId: 'card-b', dueAt: 20 }),
      card({ cardId: 'card-a', dueAt: 99, repetitions: 2 }),
    ]);
  });
});
