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
import { RELEARN_DELAY_MS, REVIEW_DAY_MS } from '@/lib/learning/review';
import { recordQuizLearning } from '@/lib/learning/record-quiz';
import {
  ensureReviewCards,
  loadLearningState,
  recordReviewRating,
  type LearningStoreDeps,
} from '@/lib/learning/store';

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

  it('advances a rated card and records half-weight review evidence', async () => {
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
    const before = (await loadLearningState({ stageId: STAGE_ID }, deps(store))).reviewCards[0];
    expect(before).toMatchObject({ sceneId: SCENE_ID, itemId: 'q1', repetitions: 0 });

    const result = await recordReviewRating(
      { stageId: STAGE_ID, card: before, rating: 'good', reviewId: 'review-1' },
      { store: store as never, learnerKey: LEARNER_KEY, now: () => 2_000 },
    );

    expect(result.card).toMatchObject({
      cardId: before.cardId,
      repetitions: 1,
      intervalDays: 1,
      dueAt: 2_000 + REVIEW_DAY_MS,
    });
    expect(result.evidence).toMatchObject({
      id: 'review:review-1',
      itemId: before.cardId,
      source: 'review',
      score: 1,
      weight: 0.5,
      conceptIds: ['recursion', 'base case'],
    });

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence.map((record) => record.id)).toContain('review:review-1');
    expect(state.reviewCards[0].dueAt).toBe(2_000 + REVIEW_DAY_MS);
  });

  it('does not advance the schedule twice for one review id', async () => {
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
    const before = (await loadLearningState({ stageId: STAGE_ID }, deps(store))).reviewCards[0];
    const input = {
      stageId: STAGE_ID,
      card: before,
      rating: 'good' as const,
      reviewId: 'review-1',
    };
    const ratingDeps = { store: store as never, learnerKey: LEARNER_KEY, now: () => 2_000 };

    const first = await recordReviewRating(input, ratingDeps);
    const replay = await recordReviewRating(input, { ...ratingDeps, now: () => 9_000 });

    expect(replay.card.dueAt).toBe(first.card.dueAt);
    expect(replay.evidence.id).toBe('review:review-1');
    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence.filter((record) => record.id === 'review:review-1')).toHaveLength(1);
  });

  it('returns a lapsed card to short-term relearning', async () => {
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
    const before = (await loadLearningState({ stageId: STAGE_ID }, deps(store))).reviewCards[0];
    const result = await recordReviewRating(
      { stageId: STAGE_ID, card: before, rating: 'again', reviewId: 'review-again' },
      { store: store as never, learnerKey: LEARNER_KEY, now: () => 2_000 },
    );

    expect(result.card).toMatchObject({
      repetitions: 0,
      intervalDays: 0,
      lapses: 0,
      dueAt: 2_000 + RELEARN_DELAY_MS,
    });
    expect(result.evidence.score).toBe(0);
  });
});
