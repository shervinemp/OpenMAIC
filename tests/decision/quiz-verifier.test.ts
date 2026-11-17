import { describe, expect, it, vi } from 'vitest';
import type { QuizVerificationQuestion } from '@openmaic/generation';

import { createDecisionQuizVerifier } from '@/lib/decision/sites/quiz-verifier';
import type { DecisionProvider, DecisionResult, DecisionSiteConfig } from '@/lib/decision/types';

function config(over: Partial<DecisionSiteConfig> = {}): DecisionSiteConfig {
  return {
    site: 'quiz-verify',
    provider: 'laya',
    mode: 'replace',
    endpoint: 'http://127.0.0.1:8090',
    timeoutMs: 1_000,
    minConfidence: 0.9,
    maxInputChars: 10_000,
    fallback: 'llm',
    ...over,
  };
}

const questions: QuizVerificationQuestion[] = [
  {
    id: 'q1',
    type: 'single',
    question: 'What stops recursion?',
    options: [
      { value: 'A', label: 'A base case' },
      { value: 'B', label: 'A larger input' },
    ],
  },
  {
    id: 'q2',
    type: 'multiple',
    question: 'Which are required?',
    options: [
      { value: 'A', label: 'Base case' },
      { value: 'B', label: 'Recursive step' },
      { value: 'C', label: 'Global counter' },
    ],
  },
];

function provider(answers: DecisionResult['answers']): DecisionProvider {
  return {
    id: 'fake',
    async decide() {
      return { provider: 'fake', answers, abstained: new Set(), latencyMs: 2 };
    },
  };
}

describe('decision quiz verifier', () => {
  it('maps choices back to option values and tolerates partial answers', async () => {
    const verifier = createDecisionQuizVerifier({
      config: config(),
      provider: provider(
        new Map([
          ['q1', { kind: 'choice', values: ['A'], confidence: 0.95 }],
          ['q2', { kind: 'choice', values: ['A', 'B'], confidence: 0.8 }],
        ]),
      ),
    });

    const answers = await verifier(questions);
    expect(answers).toEqual([
      { id: 'q1', answers: ['A'] },
      { id: 'q2', answers: ['A', 'B'] },
    ]);
  });

  it('drops unknown option values and an unusable single answer', async () => {
    const verifier = createDecisionQuizVerifier({
      config: config(),
      provider: provider(
        new Map([
          ['q1', { kind: 'choice', values: ['Z'], confidence: 0.95 }],
          ['q2', { kind: 'choice', values: ['B', 'Z', 'A'], confidence: 0.8 }],
        ]),
      ),
    });

    const answers = await verifier(questions);
    expect(answers).toEqual([{ id: 'q2', answers: ['B', 'A'] }]);
  });

  it('returns no signal when nothing usable came back', async () => {
    const verifier = createDecisionQuizVerifier({
      config: config(),
      provider: provider(new Map()),
    });

    expect(await verifier(questions)).toBeUndefined();
  });

  it('returns the LLM baseline in shadow mode', async () => {
    const baseline = vi.fn(async () => [{ id: 'q1', answers: ['B'] }]);
    const verifier = createDecisionQuizVerifier({
      config: config({ mode: 'shadow' }),
      baseline,
      provider: provider(new Map([['q1', { kind: 'choice', values: ['A'], confidence: 0.99 }]])),
    });

    await expect(verifier(questions)).resolves.toEqual([{ id: 'q1', answers: ['B'] }]);
    expect(baseline).toHaveBeenCalledTimes(1);
  });
});
