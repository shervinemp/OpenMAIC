import { describe, expect, it } from 'vitest';
import type { ExamAttempt, ExamSpec } from '@/lib/types/exam';
import { computeExamAnalytics } from '@/lib/exam/analytics';
import { buildExamVariant } from '@/lib/exam/variants';

function examSpec(overrides: Partial<ExamSpec> = {}): ExamSpec {
  return {
    kind: 'midterm',
    title: 'Midterm',
    coverage: 'Units 1-2',
    unitRange: { from: 0, to: 1 },
    mcQuestions: [1, 2, 3].map((index) => ({
      id: `mc_${index}`,
      question: `Question ${index}?`,
      options: [
        { label: 'right', value: 'A' },
        { label: 'wrong', value: 'B' },
      ],
      answer: ['A'],
      analysis: 'A.',
      points: 1,
    })),
    frQuestions: [1, 2].map((index) => ({
      id: `fr_${index}`,
      prompt: `Written ${index}`,
      rubric: [
        { id: `r${index}a`, criterion: 'a', weight: 'essential' as const, lookFor: 'a' },
        { id: `r${index}b`, criterion: 'b', weight: 'important' as const, lookFor: 'b' },
      ],
      sampleAnswer: 'sample',
      maxPoints: 10,
    })),
    formConfig: { mcCount: 3, frCount: 2 },
    timing: { mcSec: 1200, frSec: 1800 },
    generatedAt: 1,
    ...overrides,
  };
}

function attempt(id: string, overrides: Partial<ExamAttempt> = {}): ExamAttempt {
  return {
    id,
    kind: 'midterm',
    variantSeed: undefined,
    mcAnswers: {},
    frAnswers: {},
    mcResults: {
      mc_1: { correct: true, earned: 1 },
      mc_2: { correct: false, earned: 0 },
      mc_3: { correct: true, earned: 1 },
    },
    frGrades: [
      { questionId: 'fr_1', score: 8, maxPoints: 10, comment: '' },
      { questionId: 'fr_2', score: 4, maxPoints: 10, comment: '' },
    ],
    scorePct: 0.6,
    submittedAt: 1,
    ...overrides,
  };
}

describe('computeExamAnalytics', () => {
  it('returns empty metrics with no attempts', () => {
    expect(computeExamAnalytics(examSpec(), [])).toEqual({
      attempts: 0,
      gradedAttempts: 0,
      averageScorePct: null,
      bestScorePct: null,
      latestScorePct: null,
      trend: [],
      mc: [],
      fr: [],
      timedOut: 0,
    });
  });

  it('summarises scores in submission order and ignores ungraded attempts', () => {
    const analytics = computeExamAnalytics(examSpec(), [
      attempt('a', { scorePct: 0.5, submittedAt: 30 }),
      attempt('b', { scorePct: 0.8, submittedAt: 10 }),
      attempt('c', { scorePct: null, submittedAt: 20 }),
      attempt('d', { scorePct: 1, submittedAt: 40 }),
    ]);
    expect(analytics.attempts).toBe(4);
    expect(analytics.gradedAttempts).toBe(3);
    expect(analytics.bestScorePct).toBe(1);
    expect(analytics.latestScorePct).toBe(1);
    expect(analytics.averageScorePct).toBeCloseTo((0.5 + 0.8 + 1) / 3);
    expect(analytics.trend.map((point) => point.scorePct)).toEqual([0.8, 0.5, 1]);
  });

  it('aggregates MC accuracy by question id, weakest first', () => {
    const analytics = computeExamAnalytics(examSpec(), [
      attempt('a'),
      attempt('b', {
        mcResults: {
          mc_1: { correct: true, earned: 1 },
          mc_2: { correct: true, earned: 1 },
          mc_3: { correct: false, earned: 0 },
        },
      }),
      attempt('c', {
        mcResults: {
          mc_1: { correct: false, earned: 0 },
          mc_2: { correct: false, earned: 0 },
          mc_3: { correct: false, earned: 0 },
        },
      }),
    ]);
    expect(analytics.mc.map((stat) => stat.questionId)).toEqual(['mc_2', 'mc_3', 'mc_1']);
    expect(analytics.mc).toEqual([
      { questionId: 'mc_2', question: 'Question 2?', attempts: 3, correct: 1, accuracy: 1 / 3 },
      { questionId: 'mc_3', question: 'Question 3?', attempts: 3, correct: 1, accuracy: 1 / 3 },
      { questionId: 'mc_1', question: 'Question 1?', attempts: 3, correct: 2, accuracy: 2 / 3 },
    ]);
  });

  it('only counts questions a variant actually presented', () => {
    const spec = examSpec({ formConfig: { mcCount: 2, frCount: 1 } });
    const attempts = ['seed-a', 'seed-b'].map((seed, index) => {
      const variant = buildExamVariant(spec, seed);
      return attempt(`a${index}`, {
        variantSeed: seed,
        mcResults: Object.fromEntries(
          variant.mcQuestions.map((question) => [
            question.id,
            { correct: true, earned: question.points },
          ]),
        ),
        frGrades: [
          { questionId: variant.frQuestions[0]!.id, score: 10, maxPoints: 10, comment: '' },
        ],
      });
    });
    const analytics = computeExamAnalytics(spec, attempts);
    expect(analytics.mc.reduce((sum, stat) => sum + stat.attempts, 0)).toBe(4);
    expect(analytics.mc.every((stat) => stat.attempts === 1 || stat.attempts === 2)).toBe(true);
    expect(analytics.mc.every((stat) => stat.accuracy === 1)).toBe(true);
    expect(analytics.fr.reduce((sum, stat) => sum + stat.attempts, 0)).toBe(2);
  });

  it('averages written scores as fractions of each question maximum', () => {
    const analytics = computeExamAnalytics(examSpec(), [
      attempt('a', {
        frGrades: [
          { questionId: 'fr_1', score: 6, maxPoints: 10, comment: '' },
          { questionId: 'fr_2', score: 5, maxPoints: 5, comment: '' },
        ],
      }),
      attempt('b', {
        frGrades: [
          { questionId: 'fr_1', score: 8, maxPoints: 10, comment: '' },
          { questionId: 'fr_2', score: 0, maxPoints: 5, comment: '' },
        ],
      }),
    ]);
    expect(analytics.fr).toEqual([
      { questionId: 'fr_2', prompt: 'Written 2', attempts: 2, averagePct: 0.5 },
      { questionId: 'fr_1', prompt: 'Written 1', attempts: 2, averagePct: 0.7 },
    ]);
  });

  it('counts timer submissions for the list badge', () => {
    const analytics = computeExamAnalytics(examSpec(), [
      attempt('a', { timedOut: true }),
      attempt('b'),
    ]);
    expect(analytics.timedOut).toBe(1);
  });
});
