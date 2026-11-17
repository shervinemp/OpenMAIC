import { describe, expect, it } from 'vitest';

import {
  buildQuizDecisionRequest,
  compareQuizGrades,
  quizDecisionInputChars,
  quizGradeFromResult,
  type QuizDecisionInput,
} from '@/lib/decision/sites/quiz-grade';
import type { DecisionAnswer, DecisionSiteConfig } from '@/lib/decision/types';

function config(over: Partial<DecisionSiteConfig> = {}): DecisionSiteConfig {
  return {
    site: 'quiz-grade',
    provider: 'chat',
    model: 'ollama:qwen3:4b',
    mode: 'triage',
    timeoutMs: 2_000,
    minConfidence: 0.9,
    maxInputChars: 8_000,
    fallback: 'llm',
    ...over,
  };
}

const input: QuizDecisionInput = {
  question: 'Why does a process need its own address space?',
  userAnswer: 'It isolates memory between processes.',
  points: 10,
  commentPrompt: 'Reward the isolation argument.',
};

function result(score: number, confidence = 0.95) {
  return {
    provider: 'fake',
    answers: new Map<string, DecisionAnswer>([
      ['__score', { kind: 'score', value: score, confidence }],
    ]),
    abstained: new Set<string>(),
    latencyMs: 1,
  };
}

describe('quiz decision grading', () => {
  it('builds one bounded score question', () => {
    const request = buildQuizDecisionRequest(input);
    expect(request.questions).toEqual([
      {
        id: '__score',
        kind: 'score',
        prompt: 'Award the answer a score from 0 to 10.',
        min: 0,
        max: 10,
      },
    ]);
    expect(quizDecisionInputChars(request)).toBeGreaterThan(input.userAnswer.length);
  });

  it('uses any bounded score in replace mode', () => {
    const grade = quizGradeFromResult(result(7), input, config({ mode: 'replace' }));
    expect(grade).toEqual({ value: { score: 7, comment: '' }, confidence: 0.95 });
  });

  it('uses only a clear zero or full score in triage mode', () => {
    expect(quizGradeFromResult(result(7), input, config())).toBeNull();
    expect(quizGradeFromResult(result(0), input, config())?.value.score).toBe(0);
    expect(quizGradeFromResult(result(10), input, config())?.value.score).toBe(10);
  });

  it('clamps a score to the question maximum and refuses no answer', () => {
    expect(quizGradeFromResult(result(99), input, config({ mode: 'replace' }))?.value.score).toBe(
      10,
    );
    expect(
      quizGradeFromResult(
        {
          provider: 'fake',
          answers: new Map(),
          abstained: new Set(['__score']),
          latencyMs: 1,
        },
        input,
        config({ mode: 'replace' }),
      ),
    ).toBeNull();
  });

  it('compares scores for shadow agreement', () => {
    expect(compareQuizGrades({ score: 7 }, { score: 7 })).toBe(true);
    expect(compareQuizGrades({ score: 7 }, { score: 6 })).toBe(false);
  });
});
