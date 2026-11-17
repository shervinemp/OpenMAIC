import { describe, expect, it } from 'vitest';

import { recordExamLearning } from '@/lib/learning/record-exam';
import { loadLearningState, type LearningStoreDeps } from '@/lib/learning/store';
import type { ExamAttempt, ExamSpec } from '@/lib/types/exam';

import { FakeRuntimeStore } from './fake-runtime-store';

const STAGE_ID = 'stage-1';
const LEARNER_KEY = 'learner-1';

const spec: ExamSpec = {
  kind: 'midterm',
  title: 'Midterm',
  coverage: 'Units 1-2',
  unitRange: { from: 0, to: 1 },
  mcQuestions: [
    {
      id: 'mc1',
      question: 'Which one?',
      options: [],
      answer: ['A'],
      analysis: '',
      points: 2,
      concepts: ['Recursion'],
    },
    {
      id: 'mc2',
      question: 'Which other one?',
      options: [],
      answer: ['B'],
      analysis: '',
      points: 1,
      concepts: ['Base Case'],
    },
  ],
  frQuestions: [
    {
      id: 'fr1',
      prompt: 'Explain the call stack',
      rubric: [],
      sampleAnswer: '',
      maxPoints: 6,
      concepts: ['Call Stack'],
    },
    {
      id: 'fr2',
      prompt: 'Explain loops',
      rubric: [],
      sampleAnswer: '',
      maxPoints: 4,
      concepts: ['Loops'],
    },
  ],
  generatedAt: 100,
};

function attempt(over: Partial<ExamAttempt> = {}): ExamAttempt {
  return {
    id: 'attempt-1',
    kind: 'midterm',
    specGeneratedAt: 100,
    mcAnswers: { mc1: 'A' },
    frAnswers: { fr1: 'an answer', fr2: '' },
    mcResults: {
      mc1: { correct: true, earned: 2 },
      mc2: { correct: false, earned: 0 },
    },
    frGrades: [{ questionId: 'fr1', score: 3, maxPoints: 6, comment: '' }],
    scorePct: 0.5,
    submittedAt: 1_000,
    gradedAt: 1_100,
    ...over,
  };
}

function deps(store: FakeRuntimeStore): LearningStoreDeps {
  return { store: store as never, learnerKey: LEARNER_KEY, now: () => 1_000 };
}

function record(store: FakeRuntimeStore, over: Partial<ExamAttempt> = {}) {
  return recordExamLearning({
    stageId: STAGE_ID,
    spec,
    attempt: attempt(over),
    recordedAt: 1_000,
    learnerKey: LEARNER_KEY,
    store: store as never,
  });
}

describe('exam learning persistence', () => {
  it('writes evidence for MC and FR items without creating review cards', async () => {
    const store = new FakeRuntimeStore();
    await record(store);

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence).toHaveLength(4);
    expect(state.evidence.map((entry) => entry.id)).toEqual([
      'stage-1:exam:midterm:attempt-1:mc:mc1',
      'stage-1:exam:midterm:attempt-1:mc:mc2',
      'stage-1:exam:midterm:attempt-1:fr:fr1',
      'stage-1:exam:midterm:attempt-1:fr:fr2',
    ]);
    expect(state.evidence[0]).toMatchObject({
      conceptIds: ['recursion'],
      source: 'exam',
      score: 1,
      outcome: 'graded',
    });
    expect(state.evidence[2]).toMatchObject({ score: 0.5, outcome: 'graded' });
    expect(state.evidence[3]).toMatchObject({ score: 0, outcome: 'ungraded' });
    // Exam items have no owning scene yet, so they do not enter the queue.
    expect(state.reviewCards).toHaveLength(0);
  });

  it('is idempotent when the same attempt is recorded twice', async () => {
    const store = new FakeRuntimeStore();
    await record(store);
    const sessionId = store.sessions.keys().next().value!;
    const count = (await store.listRecords(sessionId)).length;

    await record(store);

    expect((await store.listRecords(sessionId)).length).toBe(count);
    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence).toHaveLength(4);
  });

  it('skips an attempt drawn from a different exam pool', async () => {
    const store = new FakeRuntimeStore();
    await record(store, { specGeneratedAt: 99 });

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence).toHaveLength(0);
    expect(store.sessions.size).toBe(0);
  });

  it('does not backfill legacy attempts without a pool stamp', async () => {
    const store = new FakeRuntimeStore();
    await record(store, { specGeneratedAt: undefined });

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence).toHaveLength(0);
  });

  it('falls back to the attempt grading time when no clock is passed', async () => {
    const store = new FakeRuntimeStore();
    await recordExamLearning({
      stageId: STAGE_ID,
      spec,
      attempt: attempt(),
      learnerKey: LEARNER_KEY,
      store: store as never,
    });

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence.every((entry) => entry.recordedAt === 1_100)).toBe(true);
  });
});
