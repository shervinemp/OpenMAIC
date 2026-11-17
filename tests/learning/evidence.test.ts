import { describe, expect, it } from 'vitest';

import {
  appendEvidence,
  DEFAULT_EVIDENCE_LIMIT,
  hasEvidence,
  normalizeEvidence,
} from '@/lib/learning/evidence';
import type { LearningEvidence } from '@/lib/learning/types';

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

describe('evidence log', () => {
  it('appends a valid record and keeps it addressable by id', () => {
    const log = appendEvidence([], evidence());
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ id: 'evt_1', score: 1 });
    expect(hasEvidence(log, 'evt_1')).toBe(true);
  });

  it('is idempotent: the first write for an id wins', () => {
    const first = appendEvidence([], evidence());
    const replayed = appendEvidence(first, evidence({ score: 0, recordedAt: 2_000 }));
    expect(replayed).toBe(first);
    expect(replayed[0].score).toBe(1);
  });

  it('drops malformed records instead of counting them as wrong answers', () => {
    const base = appendEvidence([], evidence());
    const malformed = [
      evidence({ id: '' }),
      evidence({ learnerKey: '' }),
      evidence({ source: 'unknown' as LearningEvidence['source'] }),
      evidence({ outcome: 'maybe' as LearningEvidence['outcome'] }),
      evidence({ recordedAt: Number.NaN }),
      evidence({ score: Number.NaN }),
    ];
    for (const record of malformed) {
      expect(appendEvidence(base, record)).toBe(base);
    }
  });

  it('clamps scores and normalizes concept tags and weight', () => {
    const high = normalizeEvidence(
      evidence({ score: 4, conceptIds: [' recursion ', 'recursion', '', 7 as never], weight: 99 }),
    );
    expect(high).toMatchObject({ score: 1, conceptIds: ['recursion'], weight: 4 });

    const low = normalizeEvidence(evidence({ id: 'evt_2', score: -3 }));
    expect(low).toMatchObject({ score: 0 });

    const ungraded = normalizeEvidence(evidence({ id: 'evt_3', outcome: 'ungraded', score: 0.8 }));
    expect(ungraded).toMatchObject({ outcome: 'ungraded', score: 0 });

    const noScore = normalizeEvidence(
      evidence({ id: 'evt_5', outcome: 'ungraded', score: undefined as never }),
    );
    expect(noScore).toMatchObject({ outcome: 'ungraded', score: 0 });

    const noWeight = normalizeEvidence(evidence({ id: 'evt_4', weight: 0 }));
    expect(noWeight && 'weight' in noWeight).toBe(false);
  });

  it('caps a tag list so a model cannot make one record unbounded', () => {
    const concepts = Array.from({ length: 20 }, (_, index) => `c${index}`);
    const record = normalizeEvidence(evidence({ conceptIds: concepts }));
    expect(record?.conceptIds).toHaveLength(16);
  });

  it('trims the oldest records by timestamp while preserving insertion order', () => {
    let log: readonly LearningEvidence[] = [];
    log = appendEvidence(log, evidence({ id: 'a', recordedAt: 30 }), { limit: 2 });
    log = appendEvidence(log, evidence({ id: 'b', recordedAt: 10 }), { limit: 2 });
    log = appendEvidence(log, evidence({ id: 'c', recordedAt: 20 }), { limit: 2 });

    expect(log.map((record) => record.id)).toEqual(['a', 'c']);
  });

  it('defaults to a bounded log', () => {
    const log = Array.from({ length: DEFAULT_EVIDENCE_LIMIT }, (_, index) =>
      evidence({ id: `evt_${index}`, recordedAt: index }),
    );
    const next = appendEvidence(log, evidence({ id: 'new', recordedAt: DEFAULT_EVIDENCE_LIMIT }));
    expect(next).toHaveLength(DEFAULT_EVIDENCE_LIMIT);
    expect(next[0].id).toBe('evt_1');
    expect(next[next.length - 1].id).toBe('new');
  });
});
