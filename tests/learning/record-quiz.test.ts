import { describe, expect, it } from 'vitest';
import {
  RUNTIME_DSL_VERSION,
  type RuntimeRecord,
  type RuntimeRecordInit,
  type RuntimeSession,
} from '@openmaic/dsl';
import type { RuntimeSessionInit } from '@openmaic/storage';

import type { QuestionResult } from '@/lib/quiz/grading';
import type { QuizQuestion } from '@/lib/types/stage';
import { recordQuizLearning } from '@/lib/learning/record-quiz';
import { ensureReviewCards, loadLearningState, type LearningStoreDeps } from '@/lib/learning/store';

/**
 * A minimal append-only runtime store: enough of the contract for the
 * learner-partition writes, with the store's ordering rules (per-session seq,
 * creation-ordered listings) preserved so tests exercise the real read path.
 */
class FakeRuntimeStore {
  readonly sessions = new Map<string, RuntimeSession>();
  readonly records = new Map<string, RuntimeRecord[]>();
  private sessionCreatedAt = 0;
  private seq = new Map<string, number>();

  async createSession(init: RuntimeSessionInit): Promise<RuntimeSession> {
    if (this.sessions.has(init.id)) throw new Error(`session ${init.id} already exists`);
    this.sessionCreatedAt += 1;
    const session: RuntimeSession = {
      ...init,
      createdAt: new Date(this.sessionCreatedAt).toISOString(),
      updatedAt: new Date(this.sessionCreatedAt).toISOString(),
      runtimeDslVersion: RUNTIME_DSL_VERSION,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async getSession(id: string): Promise<RuntimeSession | undefined> {
    return this.sessions.get(id);
  }

  async listSessions(stageId: string, learnerKey: string): Promise<RuntimeSession[]> {
    return [...this.sessions.values()]
      .filter((session) => session.stageId === stageId && session.learnerKey === learnerKey)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async appendRecord(init: RuntimeRecordInit): Promise<RuntimeRecord> {
    const next = (this.seq.get(init.sessionId) ?? 0) + 1;
    this.seq.set(init.sessionId, next);
    const record = { ...init, seq: next } as RuntimeRecord;
    this.records.set(init.sessionId, [...(this.records.get(init.sessionId) ?? []), record]);
    return record;
  }

  async listRecords(sessionId: string): Promise<RuntimeRecord[]> {
    return [...(this.records.get(sessionId) ?? [])].sort((a, b) => a.seq - b.seq);
  }
}

const STAGE_ID = 'stage-1';
const SCENE_ID = 'scene-1';
const LEARNER_KEY = 'learner-1';

function questions(): QuizQuestion[] {
  return [
    {
      id: 'q1',
      type: 'single',
      question: 'What stops recursion?',
      options: [
        { value: 'A', label: 'A base case' },
        { value: 'B', label: 'A bigger input' },
      ],
      answer: ['A'],
      hasAnswer: true,
      points: 10,
      concepts: ['Recursion', 'recursion.', 'Base Case'],
    },
    {
      id: 'q2',
      type: 'short_answer',
      question: 'Explain the call stack.',
      hasAnswer: false,
      points: 5,
      concepts: ['call stack'],
    },
  ];
}

function results(): QuestionResult[] {
  return [
    { questionId: 'q1', correct: true, status: 'correct', earned: 10 },
    { questionId: 'q2', correct: null, status: 'ungraded', earned: 0 },
  ];
}

function deps(store: FakeRuntimeStore): LearningStoreDeps {
  return { store: store as never, learnerKey: LEARNER_KEY, now: () => 1_000 };
}

describe('quiz learning persistence', () => {
  it('writes evidence and cards to the learner partition', async () => {
    const store = new FakeRuntimeStore();
    await recordQuizLearning({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      attemptId: 'attempt-1',
      questions: questions(),
      results: results(),
      recordedAt: 1_000,
      learnerKey: LEARNER_KEY,
      store: store as never,
    });

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence).toHaveLength(2);
    expect(state.evidence[0]).toMatchObject({
      id: 'stage-1:quiz:scene-1:attempt-1:q1',
      conceptIds: ['recursion', 'base case'],
      score: 1,
      outcome: 'graded',
    });
    expect(state.evidence[1]).toMatchObject({
      id: 'stage-1:quiz:scene-1:attempt-1:q2',
      conceptIds: ['call stack'],
      outcome: 'ungraded',
    });

    // The ungraded question is evidence but not a review card.
    expect(state.reviewCards).toHaveLength(1);
    expect(state.reviewCards[0]).toMatchObject({
      cardId: 'stage-1:scene-1:q1',
      conceptIds: ['recursion', 'base case'],
      repetitions: 0,
      dueAt: 1_000,
    });

    const sessions = await store.listSessions(STAGE_ID, LEARNER_KEY);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ kind: 'learning', status: 'active' });
  });

  it('is idempotent when the reviewed attempt is recorded twice', async () => {
    const store = new FakeRuntimeStore();
    const input = {
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      attemptId: 'attempt-1',
      questions: questions(),
      results: results(),
      recordedAt: 1_000,
      learnerKey: LEARNER_KEY,
      store: store as never,
    };
    await recordQuizLearning(input);
    const recordsAfterFirst = (await store.listRecords(store.sessions.keys().next().value!)).length;

    await recordQuizLearning(input);

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence).toHaveLength(2);
    expect(state.reviewCards).toHaveLength(1);
    expect((await store.listRecords(store.sessions.keys().next().value!)).length).toBe(
      recordsAfterFirst,
    );
  });

  it('refreshes tags without rescheduling an existing card', async () => {
    const store = new FakeRuntimeStore();
    await recordQuizLearning({
      stageId: STAGE_ID,
      sceneId: SCENE_ID,
      attemptId: 'attempt-1',
      questions: questions(),
      results: results(),
      recordedAt: 1_000,
      learnerKey: LEARNER_KEY,
      store: store as never,
    });

    await ensureReviewCards(
      {
        stageId: STAGE_ID,
        items: [{ sceneId: SCENE_ID, itemId: 'q1', conceptIds: ['recursion', 'stack frame'] }],
      },
      deps(store),
    );

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.reviewCards).toHaveLength(1);
    expect(state.reviewCards[0].conceptIds).toEqual(['recursion', 'stack frame']);
    expect(state.reviewCards[0].dueAt).toBe(1_000);
  });
});
