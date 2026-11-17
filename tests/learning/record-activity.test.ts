import { describe, expect, it } from 'vitest';

import type { ActivityCheckResult } from '@/lib/activity/checks';
import { recordActivityLearning } from '@/lib/learning/record-activity';
import { loadLearningState, type LearningStoreDeps } from '@/lib/learning/store';

import { FakeRuntimeStore } from './fake-runtime-store';

const STAGE_ID = 'stage-1';
const SCENE_ID = 'scene-1';
const LEARNER_KEY = 'learner-1';

const results: ActivityCheckResult[] = [
  { checkId: 'tests', status: 'passed', earned: 1, possible: 1 },
  { checkId: 'output', status: 'failed', earned: 0, possible: 1 },
];

function deps(store: FakeRuntimeStore): LearningStoreDeps {
  return { store: store as never, learnerKey: LEARNER_KEY, now: () => 1_000 };
}

function record(
  store: FakeRuntimeStore,
  overrides: Partial<Parameters<typeof recordActivityLearning>[0]> = {},
) {
  return recordActivityLearning({
    stageId: STAGE_ID,
    sceneId: SCENE_ID,
    attemptId: 'run-1',
    concepts: ['Recursion'],
    results,
    recordedAt: 1_000,
    learnerKey: LEARNER_KEY,
    store: store as never,
    ...overrides,
  });
}

describe('activity learning persistence', () => {
  it('writes per-check evidence without creating review cards', async () => {
    const store = new FakeRuntimeStore();
    await record(store);

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence).toHaveLength(2);
    expect(state.evidence.map((entry) => entry.id)).toEqual([
      'stage-1:activity:scene-1:run-1:tests',
      'stage-1:activity:scene-1:run-1:output',
    ]);
    expect(state.evidence[0]).toMatchObject({
      conceptIds: ['recursion'],
      source: 'activity',
      score: 1,
      outcome: 'graded',
    });
    expect(state.evidence[1]).toMatchObject({ score: 0, outcome: 'graded' });
    expect(state.reviewCards).toHaveLength(0);
  });

  it('is idempotent when the same run is recorded twice', async () => {
    const store = new FakeRuntimeStore();
    await record(store);
    const sessionId = store.sessions.keys().next().value!;
    const count = (await store.listRecords(sessionId)).length;

    await record(store);

    expect((await store.listRecords(sessionId)).length).toBe(count);
    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence).toHaveLength(2);
  });

  it('treats a second run as a separate observation', async () => {
    const store = new FakeRuntimeStore();
    await record(store);
    await record(store, { attemptId: 'run-2', results: [{ ...results[0]! }] });

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence).toHaveLength(3);
  });

  it('skips a run where the harness could grade nothing', async () => {
    const store = new FakeRuntimeStore();
    await record(store, {
      results: results.map((result) => ({
        ...result,
        status: 'ungraded' as const,
        earned: 0,
      })),
    });

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence).toHaveLength(0);
    expect(store.sessions.size).toBe(0);
  });

  it('keeps partial observability: graded and ungraded checks in one run', async () => {
    const store = new FakeRuntimeStore();
    await record(store, {
      results: [...results, { checkId: 'file', status: 'ungraded', earned: 0, possible: 1 }],
    });

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence).toHaveLength(3);
    expect(state.evidence[2]).toMatchObject({ outcome: 'ungraded' });
  });

  it('falls back to the current clock when no time is passed', async () => {
    const store = new FakeRuntimeStore();
    await record(store, { recordedAt: undefined });

    const state = await loadLearningState({ stageId: STAGE_ID }, deps(store));
    expect(state.evidence.every((entry) => entry.recordedAt > 0)).toBe(true);
  });
});
