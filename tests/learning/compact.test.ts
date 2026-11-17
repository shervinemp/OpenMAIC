import { beforeEach, describe, expect, it } from 'vitest';

import type { LearningEvidence } from '@/lib/learning/types';
import {
  compactLearningHistory,
  maybeCompactLearningHistory,
  resetLearningCompactionForTests,
  LEARNING_COMPACTION_CHECK_INTERVAL_MS,
} from '@/lib/learning/compact';
import { newReviewCard } from '@/lib/learning/review';
import {
  appendLearningEvidence,
  loadLearningState,
  type LearningStoreDeps,
} from '@/lib/learning/store';
import { LEARNING_PAYLOAD_VERSION } from '@/lib/learning/store-payload';

import { FakeRuntimeStore } from './fake-runtime-store';

const STAGE_ID = 'stage-1';
const LEARNER_KEY = 'learner-1';
const NOW = Date.parse('2026-06-01T00:00:00.000Z');

function deps(store: FakeRuntimeStore, now: () => number = () => NOW): LearningStoreDeps {
  return { store: store as never, learnerKey: LEARNER_KEY, now };
}

function evidence(id: string, recordedAt: number): LearningEvidence {
  return {
    id,
    learnerKey: LEARNER_KEY,
    stageId: STAGE_ID,
    itemId: `item-${id}`,
    conceptIds: ['concept'],
    source: 'quiz',
    score: 1,
    outcome: 'graded',
    recordedAt,
  };
}

async function seedSession(
  store: FakeRuntimeStore,
  id: string,
  status: 'active' | 'archived',
  evidenceList: readonly LearningEvidence[],
  cardIds: readonly string[] = [],
  cardNow = 1_000,
): Promise<void> {
  await store.createSession({
    id,
    kind: 'learning',
    stageId: STAGE_ID,
    learnerKey: LEARNER_KEY,
    status: 'active',
    createdAt: new Date(cardNow).toISOString(),
    updatedAt: new Date(cardNow).toISOString(),
  });
  for (const entry of evidenceList) {
    await store.appendRecord({
      id: `record-${id}-${entry.id}`,
      sessionId: id,
      createdAt: new Date(entry.recordedAt).toISOString(),
      payload: {
        version: LEARNING_PAYLOAD_VERSION,
        kind: 'evidence',
        evidence: entry,
      },
    });
  }
  for (const cardId of cardIds) {
    await store.appendRecord({
      id: `record-${id}-card-${cardId}-${cardNow}`,
      sessionId: id,
      createdAt: new Date(cardNow).toISOString(),
      payload: {
        version: LEARNING_PAYLOAD_VERSION,
        kind: 'reviewCards',
        cards: [newReviewCard(cardId, ['concept'], cardNow)],
      },
    });
  }
  if (status !== 'active') {
    await store.setSessionStatus(id, status, new Date(cardNow).toISOString());
  }
}

async function appendEvidence(
  store: FakeRuntimeStore,
  sessionId: string,
  entry: LearningEvidence,
  createdAt: number,
): Promise<void> {
  await store.appendRecord({
    id: `record-${sessionId}-${entry.id}`,
    sessionId,
    createdAt: new Date(createdAt).toISOString(),
    payload: {
      version: LEARNING_PAYLOAD_VERSION,
      kind: 'evidence',
      evidence: entry,
    },
  });
}

beforeEach(() => {
  resetLearningCompactionForTests();
});

describe('learning compaction', () => {
  it('deletes an inactive session only when its evidence and cards are superseded', async () => {
    const store = new FakeRuntimeStore();
    await seedSession(store, 'old', 'archived', [evidence('e1', 1)], ['c1'], 1_000);
    await seedSession(store, 'mid', 'archived', [evidence('e2', 2), evidence('e3', 3)], [], 2_000);
    // The active session holds the newest evidence and the latest c1 snapshot.
    await seedSession(store, 'active', 'active', [evidence('e4', 4)], ['c1'], 4_000);

    const result = await compactLearningHistory(
      { stageId: STAGE_ID, evidenceLimit: 3 },
      deps(store),
    );

    expect(result).toMatchObject({
      reason: 'compacted',
      deletedSessions: 1,
      deletedRecords: 2,
      rotated: false,
      recordsBefore: 6,
      recordsAfter: 4,
    });
    expect(store.sessions.has('old')).toBe(false);
    expect(store.sessions.has('mid')).toBe(true);

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence.map((entry) => entry.id)).toEqual(['e2', 'e3', 'e4']);
    expect(state.reviewCards.map((card) => card.cardId)).toEqual(['c1']);
  });

  it('keeps a session whose only remaining contribution is the latest card snapshot', async () => {
    const store = new FakeRuntimeStore();
    await seedSession(store, 'old', 'archived', [evidence('e1', 1)], ['c1'], 1_000);
    await seedSession(store, 'active', 'active', [evidence('e2', 2)], [], 2_000);

    const result = await compactLearningHistory(
      { stageId: STAGE_ID, evidenceLimit: 1 },
      deps(store),
    );

    expect(result.deletedSessions).toBe(0);
    expect(store.sessions.has('old')).toBe(true);
  });

  it('never deletes an active session, even when its evidence is outside the window', async () => {
    const store = new FakeRuntimeStore();
    await seedSession(store, 'a', 'active', [evidence('e1', 1)], [], 1_000);
    await seedSession(store, 'b', 'active', [evidence('e2', 2)], [], 2_000);

    const result = await compactLearningHistory(
      { stageId: STAGE_ID, evidenceLimit: 1 },
      deps(store),
    );

    expect(result.deletedSessions).toBe(0);
    expect(result.rotated).toBe(false);
    expect(store.sessions.has('a')).toBe(true);
    expect(store.sessions.has('b')).toBe(true);
  });

  it('rotates one old large active session and preserves its history', async () => {
    const store = new FakeRuntimeStore();
    await seedSession(
      store,
      'active',
      'active',
      [evidence('e1', 1), evidence('e2', 2), evidence('e3', 3)],
      [],
      1_000,
    );

    const result = await compactLearningHistory(
      { stageId: STAGE_ID, evidenceLimit: 10, rotateAfterRecords: 2 },
      deps(store),
    );

    expect(result).toMatchObject({ rotated: true, reason: 'compacted', recordsAfter: 3 });
    expect(result.sessionsAfter).toBe(2);

    const sessions = await store.listSessions(STAGE_ID, LEARNER_KEY);
    expect(sessions.map((session) => session.status).sort()).toEqual(['active', 'archived']);
    const old = sessions.find((session) => session.id === 'active');
    expect(old?.status).toBe('archived');

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence.map((entry) => entry.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('deletes the rotated session on a later pass once its evidence is outside the window', async () => {
    const store = new FakeRuntimeStore();
    await seedSession(
      store,
      'old',
      'active',
      [evidence('e1', 1), evidence('e2', 2), evidence('e3', 3)],
      [],
      1_000,
    );
    await compactLearningHistory(
      { stageId: STAGE_ID, evidenceLimit: 10, rotateAfterRecords: 2 },
      deps(store),
    );
    const sessions = await store.listSessions(STAGE_ID, LEARNER_KEY);
    const current = sessions.find((session) => session.status === 'active')!;

    await appendEvidence(store, current.id, evidence('e4', 4), 2_000);
    await appendEvidence(store, current.id, evidence('e5', 5), 3_000);

    const result = await compactLearningHistory(
      { stageId: STAGE_ID, evidenceLimit: 2, rotateAfterRecords: 100 },
      deps(store),
    );

    expect(result.deletedSessions).toBe(1);
    expect(store.sessions.has('old')).toBe(false);

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence.map((entry) => entry.id)).toEqual(['e4', 'e5']);
  });

  it('throttles automatic checks per stage', async () => {
    const store = new FakeRuntimeStore();

    const first = await maybeCompactLearningHistory({ stageId: STAGE_ID }, deps(store));
    expect(first?.reason).toBe('no-sessions');

    const otherLearner = await maybeCompactLearningHistory(
      { stageId: STAGE_ID },
      { ...deps(store), learnerKey: 'learner-2' },
    );
    expect(otherLearner?.reason).toBe('no-sessions');

    const second = await maybeCompactLearningHistory({ stageId: STAGE_ID }, deps(store));
    expect(second).toBeNull();

    const later = await maybeCompactLearningHistory(
      { stageId: STAGE_ID },
      deps(store, () => NOW + LEARNING_COMPACTION_CHECK_INTERVAL_MS + 1),
    );
    expect(later?.reason).toBe('no-sessions');
  });
});

describe('append retry across compaction', () => {
  it('retries evidence on the fresh session when its first session was archived', async () => {
    class ArchivingStore extends FakeRuntimeStore {
      private archivedOnce = false;

      override async appendRecord(
        init: Parameters<FakeRuntimeStore['appendRecord']>[0],
      ): Promise<Awaited<ReturnType<FakeRuntimeStore['appendRecord']>>> {
        if (!this.archivedOnce) {
          this.archivedOnce = true;
          await this.setSessionStatus(init.sessionId, 'archived', new Date(NOW).toISOString());
        }
        return super.appendRecord(init);
      }
    }

    const store = new ArchivingStore();
    await appendLearningEvidence({ stageId: STAGE_ID, evidence: [evidence('e1', 1)] }, deps(store));

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence.map((entry) => entry.id)).toEqual(['e1']);

    const sessions = await store.listSessions(STAGE_ID, LEARNER_KEY);
    expect(sessions.map((session) => session.status).sort()).toEqual(['active', 'archived']);
  });
});
