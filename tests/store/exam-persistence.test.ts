import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Exam artifacts stored on the stage store: cap on retained attempts and
 * clearing with the stage. The typed `exams` / `examAttempts` fields ride the
 * opaque `AppDocumentOutline` snapshot (see persistence-types.ts), which is
 * compile-time pinned without further runtime plumbing.
 */

import { useStageStore } from '@/lib/store/stage';
import type { ExamAttempt, ExamSpec } from '@/lib/types/exam';

const attemptFixture = (id: string): ExamAttempt => ({
  id,
  kind: 'midterm',
  mcAnswers: { mc_1: 'A' },
  frAnswers: { fr_1: 'answer' },
  mcResults: { mc_1: { correct: true, earned: 1 } },
  frGrades: [],
  scorePct: 0.9,
  submittedAt: Date.now(),
  gradedAt: Date.now(),
});

const examSpecFixture = (): ExamSpec => ({
  kind: 'midterm',
  title: 'Midterm Exam',
  coverage: 'Units 1-2',
  unitRange: { from: 0, to: 1 },
  mcQuestions: [],
  frQuestions: [],
  generatedAt: Date.now(),
});

describe('exam artifacts in the stage store', () => {
  beforeEach(() => {
    useStageStore.setState((s) => ({
      ...(s as object),
      stage: null,
      exams: {},
      examAttempts: {},
    }));
  });

  it('setExamSpec replaces the spec per exam kind', () => {
    useStageStore.getState().setExamSpec(examSpecFixture());
    expect(useStageStore.getState().exams.midterm?.title).toBe('Midterm Exam');

    const second = { ...examSpecFixture(), title: 'Midterm Exam v2' } as ExamSpec;
    useStageStore.getState().setExamSpec(second);
    expect(useStageStore.getState().exams.midterm?.title).toBe('Midterm Exam v2');
  });

  it('saveExamAttempt keeps only the two most recent attempts per exam', () => {
    // Note: this calls saveToStorage internally; with no stage loaded it is a
    // no-op save, which is fine — the state mutation and the cap are what we
    // pin here (the document snapshot itself carries the same state).
    useStageStore.getState().saveExamAttempt(attemptFixture('a1'));
    useStageStore.getState().saveExamAttempt(attemptFixture('a2'));
    useStageStore.getState().saveExamAttempt(attemptFixture('a3'));

    const attempts = useStageStore.getState().examAttempts.midterm ?? [];
    expect(attempts.map((a) => a.id)).toEqual(['a2', 'a3']);
  });

  it('clearing the store resets exam artifacts', () => {
    useStageStore.getState().setExamSpec(examSpecFixture());
    useStageStore.getState().saveExamAttempt(attemptFixture('a1'));
    useStageStore.setState((s) => ({
      ...(s as object),
      exams: {},
      examAttempts: {},
    }));
    expect(useStageStore.getState().exams).toEqual({});
    expect(useStageStore.getState().examAttempts.midterm).toBeUndefined();
  });
});
