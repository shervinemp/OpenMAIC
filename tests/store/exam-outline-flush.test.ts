import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The store's flush imports stage-storage dynamically; mock it so the
// outline-dirty write can be observed without IndexedDB.
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: vi.fn().mockResolvedValue(undefined),
  loadStageData: vi.fn().mockResolvedValue(null),
}));

import { useStageStore } from '@/lib/store/stage';
import { unmarkStageDeleted } from '@/lib/utils/deleted-stages';
import { saveStageDataIncremental } from '@/lib/utils/stage-storage';
import type { ExamAttempt, ExamSpec } from '@/lib/types/exam';
import type { SceneOutline } from '@/lib/types/generation';

const spec: ExamSpec = {
  kind: 'midterm',
  title: 'Midterm Exam',
  coverage: 'Units 1-2',
  unitRange: { from: 0, to: 1 },
  mcQuestions: [],
  frQuestions: [],
  generatedAt: 1,
};

const attempt: ExamAttempt = {
  id: 'attempt-1',
  kind: 'midterm',
  mcAnswers: {},
  frAnswers: {},
  mcResults: {},
  frGrades: [],
  scorePct: 0.8,
  submittedAt: 2,
  gradedAt: 3,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(saveStageDataIncremental).mockClear();
  useStageStore.setState({
    stage: { id: 'stage-1', name: 'Course', createdAt: 1, updatedAt: 1 },
    scenes: [],
    currentSceneId: null,
    exams: { midterm: spec },
    examAttempts: { midterm: [attempt] },
  });
});

afterEach(() => {
  useStageStore.getState().clearStore();
  unmarkStageDeleted('stage-1');
  vi.useRealTimers();
});

describe('outline-dirty flush', () => {
  it('carries the exams and graded attempts in the outline record it writes whole', async () => {
    useStageStore
      .getState()
      .setOutlines([{ id: 'o1', type: 'slide', title: 'T', order: 1 } as SceneOutline]);

    await vi.advanceTimersByTimeAsync(500);

    expect(saveStageDataIncremental).toHaveBeenCalledOnce();
    const [, dirty, storeData] = vi.mocked(saveStageDataIncremental).mock.calls[0];
    expect(dirty).toEqual(expect.arrayContaining([{ kind: 'outline' }]));
    expect(storeData.outline?.exams).toEqual({ midterm: spec });
    expect(storeData.outline?.examAttempts).toEqual({ midterm: [attempt] });
  });
});
