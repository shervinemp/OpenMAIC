import { describe, expect, it } from 'vitest';

import {
  buildExamDecisionRequest,
  compareExamGrades,
  examDecisionInputChars,
  examGradeFromResult,
  type ExamDecisionInput,
} from '@/lib/decision/sites/exam-grading';
import type { DecisionAnswer, DecisionSiteConfig } from '@/lib/decision/types';

function config(over: Partial<DecisionSiteConfig> = {}): DecisionSiteConfig {
  return {
    site: 'exam-grading',
    provider: 'laya',
    mode: 'triage',
    endpoint: 'http://127.0.0.1:8090',
    timeoutMs: 4_000,
    minConfidence: 0.9,
    maxInputChars: 12_000,
    fallback: 'llm',
    ...over,
  };
}

const input: ExamDecisionInput = {
  questionId: 'fr_1',
  prompt: 'Design a lakehouse',
  userAnswer: 'Store raw events in bronze, validate in silver.',
  rubric: [
    { id: 'r1', criterion: 'Names storage layers', weight: 'essential', lookFor: 'bronze/silver' },
    { id: 'r2', criterion: 'Explains separation', weight: 'important', lookFor: 'compute split' },
  ],
  sampleAnswer: 'A layered lakehouse.',
  maxPoints: 10,
  commentPrompt: 'Reward correct reasoning.',
  includeCriteria: true,
};

function result(answers: Record<string, DecisionAnswer>) {
  return {
    provider: 'fake',
    answers: new Map(Object.entries(answers)),
    abstained: new Set<string>(),
    latencyMs: 1,
  };
}

const met = (confidence = 0.95): DecisionAnswer => ({
  kind: 'noul',
  probability: 0.9,
  confidence,
});
const unmet = (confidence = 0.95): DecisionAnswer => ({
  kind: 'noul',
  probability: 0.1,
  confidence,
});

describe('exam decision grading', () => {
  it('builds a typed request only when per-criterion output is requested', () => {
    const request = buildExamDecisionRequest(input);
    expect(request?.questions.map((question) => question.id)).toEqual(['r1', 'r2', '__score']);
    expect(request?.state).toContain('STUDENT ANSWER');
    expect(examDecisionInputChars(request!)).toBeGreaterThan(0);

    expect(buildExamDecisionRequest({ ...input, includeCriteria: false })).toBeNull();
    expect(
      buildExamDecisionRequest({
        ...input,
        rubric: [input.rubric[0]!, { ...input.rubric[1]!, id: 'r1' }],
      }),
    ).toBeNull();
  });

  it('awards full marks when every criterion is confidently met', () => {
    const grade = examGradeFromResult(
      result({ r1: met(), r2: met(), __score: { kind: 'score', value: 4, confidence: 0.9 } }),
      input,
      config(),
    );

    expect(grade?.value).toMatchObject({
      questionId: 'fr_1',
      score: 10,
      maxPoints: 10,
      comment: '',
    });
    expect(grade?.value.criteria).toEqual([
      { id: 'r1', met: true, comment: '' },
      { id: 'r2', met: true, comment: '' },
    ]);
    expect(grade?.confidence).toBe(0.95);
  });

  it('awards zero when every criterion is confidently unmet', () => {
    const grade = examGradeFromResult(result({ r1: unmet(), r2: unmet() }), input, config());
    expect(grade?.value.score).toBe(0);
  });

  it('refuses a partial result in triage mode', () => {
    expect(
      examGradeFromResult(
        result({ r1: met(), r2: unmet(), __score: { kind: 'score', value: 7, confidence: 0.9 } }),
        input,
        config({ mode: 'triage' }),
      ),
    ).toBeNull();
  });

  it('uses the reported overall score for a partial result in replace mode', () => {
    const grade = examGradeFromResult(
      result({ r1: met(), r2: unmet(), __score: { kind: 'score', value: 7, confidence: 0.8 } }),
      input,
      config({ mode: 'replace' }),
    );

    expect(grade?.value.score).toBe(7);
    expect(grade?.value.criteria?.map((criterion) => criterion.met)).toEqual([true, false]);
    expect(grade?.confidence).toBe(0.8);
  });

  it('maps the permissive policy in shadow so agreement measures what replace would do', () => {
    const grade = examGradeFromResult(
      result({ r1: met(), r2: unmet(), __score: { kind: 'score', value: 7, confidence: 0.8 } }),
      input,
      config({ mode: 'shadow' }),
    );
    expect(grade?.value.score).toBe(7);
  });

  it('refuses a missing criterion or a missing score', () => {
    expect(examGradeFromResult(result({ r1: met() }), input, config())).toBeNull();
    expect(
      examGradeFromResult(result({ r1: met(), r2: unmet() }), input, config({ mode: 'replace' })),
    ).toBeNull();
  });

  it('compares score and criteria for shadow agreement', () => {
    const left = {
      questionId: 'fr_1',
      score: 10,
      maxPoints: 10,
      comment: '',
      criteria: [{ id: 'r1', met: true, comment: '' }],
    };
    expect(compareExamGrades(left, { ...left })).toBe(true);
    expect(compareExamGrades(left, { ...left, score: 9 })).toBe(false);
    expect(
      compareExamGrades(left, {
        ...left,
        criteria: [{ id: 'r1', met: false, comment: '' }],
      }),
    ).toBe(false);
  });
});
