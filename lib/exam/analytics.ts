/**
 * Attempt analytics for a semester exam.
 *
 * Everything here is derived from the persisted attempts plus the exam pool —
 * no extra storage, no model calls. MC accuracy is keyed by stable question id,
 * so attempts drawn from different forms still contribute to the same pool
 * statistics. Questions an attempt did not see are not counted against it.
 */

import type { ExamAttempt, ExamSpec } from '@/lib/types/exam';
import { resolveAttemptVariant } from './variants';

export interface ExamMcStat {
  questionId: string;
  question: string;
  /** Attempts whose form included this question and recorded a result. */
  attempts: number;
  correct: number;
  /** 0-1, always defined for a stat that exists. */
  accuracy: number;
}

export interface ExamFrStat {
  questionId: string;
  prompt: string;
  attempts: number;
  /** Mean fraction of the question's points earned, 0-1. */
  averagePct: number;
}

export interface ExamTrendPoint {
  submittedAt: number;
  scorePct: number;
}

export interface ExamAnalytics {
  attempts: number;
  /** Attempts with a numeric overall score. */
  gradedAttempts: number;
  averageScorePct: number | null;
  bestScorePct: number | null;
  latestScorePct: number | null;
  /** Oldest first. */
  trend: ExamTrendPoint[];
  /** Weakest first. */
  mc: ExamMcStat[];
  /** Weakest first. */
  fr: ExamFrStat[];
  timedOut: number;
}

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function computeExamAnalytics(
  spec: ExamSpec,
  attempts: readonly ExamAttempt[],
): ExamAnalytics {
  const graded = attempts.filter((attempt) => isScore(attempt.scorePct));
  const scores = graded.map((attempt) => attempt.scorePct as number);
  const trend = [...graded]
    .sort((a, b) => a.submittedAt - b.submittedAt)
    .map((attempt) => ({ submittedAt: attempt.submittedAt, scorePct: attempt.scorePct as number }));

  const mcById = new Map(spec.mcQuestions.map((question) => [question.id, question]));
  const mcTally = new Map<string, { attempts: number; correct: number }>();
  const frTally = new Map<string, { attempts: number; totalPct: number }>();
  const frById = new Map(spec.frQuestions.map((question) => [question.id, question]));

  for (const attempt of attempts) {
    const variant = resolveAttemptVariant(spec, attempt);
    for (const question of variant.mcQuestions) {
      const result = attempt.mcResults?.[question.id];
      if (!result) continue;
      const tally = mcTally.get(question.id) ?? { attempts: 0, correct: 0 };
      tally.attempts += 1;
      if (result.correct) tally.correct += 1;
      mcTally.set(question.id, tally);
    }
    for (const grade of attempt.frGrades ?? []) {
      if (!isScore(grade.score) || !isScore(grade.maxPoints) || grade.maxPoints <= 0) continue;
      const tally = frTally.get(grade.questionId) ?? { attempts: 0, totalPct: 0 };
      tally.attempts += 1;
      tally.totalPct += Math.min(1, Math.max(0, grade.score / grade.maxPoints));
      frTally.set(grade.questionId, tally);
    }
  }

  const mc: ExamMcStat[] = [...mcTally.entries()]
    .map(([questionId, tally]) => ({
      questionId,
      question: mcById.get(questionId)?.question ?? questionId,
      attempts: tally.attempts,
      correct: tally.correct,
      accuracy: tally.attempts > 0 ? tally.correct / tally.attempts : 0,
    }))
    .sort(
      (a, b) =>
        a.accuracy - b.accuracy ||
        b.attempts - a.attempts ||
        a.questionId.localeCompare(b.questionId),
    );

  const fr: ExamFrStat[] = [...frTally.entries()]
    .map(([questionId, tally]) => ({
      questionId,
      prompt: frById.get(questionId)?.prompt ?? questionId,
      attempts: tally.attempts,
      averagePct: tally.attempts > 0 ? tally.totalPct / tally.attempts : 0,
    }))
    .sort(
      (a, b) =>
        a.averagePct - b.averagePct ||
        b.attempts - a.attempts ||
        a.questionId.localeCompare(b.questionId),
    );

  return {
    attempts: attempts.length,
    gradedAttempts: graded.length,
    averageScorePct:
      scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
    bestScorePct: scores.length > 0 ? Math.max(...scores) : null,
    latestScorePct: trend.length > 0 ? trend[trend.length - 1]!.scorePct : null,
    trend,
    mc,
    fr,
    timedOut: attempts.filter((attempt) => attempt.timedOut === true).length,
  };
}
