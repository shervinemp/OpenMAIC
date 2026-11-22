import { describe, expect, it, vi } from 'vitest';

import { parseDecisionRoutes, resetDecisionConfigForTests } from '@/lib/decision/config';
import { runDecisionSite } from '@/lib/decision/router';
import type {
  DecisionResult,
  DecisionSiteConfig,
} from '@/lib/decision/types';

const config: DecisionSiteConfig = {
  site: 'quiz-grade',
  provider: 'chat',
  model: 'deepseek:deepseek-flash',
  mode: 'replace',
  fallback: 'llm',
  timeoutMs: 15_000,
  minConfidence: 0.9,
  maxInputChars: 12_000,
};

const request = {
  state: 'a learner answer',
  questions: [{ id: 'score', kind: 'score' as const, prompt: 'Grade it', min: 0, max: 10 }],
};

const decisionResult: DecisionResult = {
  provider: 'chat:test',
  answers: new Map([['score', { kind: 'score', value: 8, confidence: 0.8 }]]),
  abstained: new Set(),
  latencyMs: 5,
};

function run(deps: Parameters<typeof runDecisionSite>[1] = {}) {
  return runDecisionSite<number>({
    site: 'quiz-grade',
    inputChars: 20,
    request,
    baseline: vi.fn(async () => 6),
    fromResult: (result) => {
      const answer = result.answers.get('score');
      return answer?.kind === 'score' ? { value: answer.value, confidence: answer.confidence } : null;
    },
  }, deps);
}

describe('decision router LLM fallback', () => {
  it('uses the LLM baseline when no decision model is provided', async () => {
    resetDecisionConfigForTests();
    const outcome = await run();

    expect(outcome).toEqual({ source: 'baseline', value: 6 });
  });

  it('returns none when neither a decision model nor an LLM baseline exists', async () => {
    const outcome = await runDecisionSite<number>({
      site: 'quiz-grade',
      inputChars: 20,
      request,
      fromResult: () => null,
    });

    expect(outcome).toEqual({ source: 'none', reason: 'not-configured' });
  });

  it('falls back to the LLM when the decision model fails', async () => {
    const provider = {
      id: 'chat:broken',
      decide: vi.fn(async () => {
        throw new Error('decision model unavailable');
      }),
    };

    const outcome = await run({ config, provider });

    expect(outcome).toEqual({ source: 'baseline', value: 6 });
    expect(provider.decide).toHaveBeenCalledOnce();
  });

  it('does not call the LLM when fallback is none and the decision model fails', async () => {
    const provider = {
      id: 'chat:broken',
      decide: vi.fn(async () => {
        throw new Error('decision model unavailable');
      }),
    };

    const outcome = await run({ config: { ...config, fallback: 'none' }, provider });

    expect(outcome.source).toBe('none');
    expect(provider.decide).toHaveBeenCalledOnce();
  });

  it('uses the decision answer when it is usable (replace mode)', async () => {
    const outcome = await run({
      config,
      provider: { id: 'chat:ok', decide: async () => decisionResult },
    });

    expect(outcome).toEqual({ source: 'decision', value: 8, confidence: 0.8 });
  });

  it('keeps a valid decision-route config with an explicit llm fallback', () => {
    resetDecisionConfigForTests();
    const parsed = parseDecisionRoutes(
      JSON.stringify({
        'quiz-grade': {
          provider: 'chat',
          model: 'deepseek:deepseek-flash',
          mode: 'replace',
          fallback: 'llm',
        },
      }),
    );

    expect(parsed.get('quiz-grade')).toMatchObject({
      provider: 'chat',
      model: 'deepseek:deepseek-flash',
      mode: 'replace',
      fallback: 'llm',
    });
  });
});
