import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runDecisionSite } from '@/lib/decision/router';
import { readDecisionTelemetry, resetDecisionTelemetryForTests } from '@/lib/decision/telemetry';
import type { DecisionProvider, DecisionResult, DecisionSiteConfig } from '@/lib/decision/types';

function config(over: Partial<DecisionSiteConfig> = {}): DecisionSiteConfig {
  return {
    site: 'quiz-grade',
    provider: 'laya',
    mode: 'triage',
    endpoint: 'http://127.0.0.1:8090',
    timeoutMs: 1_000,
    minConfidence: 0.9,
    maxInputChars: 1_000,
    fallback: 'llm',
    ...over,
  };
}

function provider(
  over: {
    answer?: DecisionResult['answers'];
    confidence?: number;
    fail?: boolean;
  } = {},
): DecisionProvider {
  return {
    id: 'fake',
    async decide() {
      if (over.fail) throw new Error('down');
      return {
        provider: 'fake',
        answers: over.answer ?? new Map(),
        abstained: new Set(),
        latencyMs: 4,
      };
    },
  };
}

function scoredAnswer(confidence: number) {
  return new Map([['__score', { kind: 'score' as const, value: 5, confidence }]]);
}

const input = (over: Partial<Parameters<typeof runDecisionSite<string>>[0]> = {}) => ({
  site: 'quiz-grade' as const,
  inputChars: 10,
  request: {
    state: 'state',
    questions: [{ id: '__score', kind: 'score' as const, prompt: 'Score', min: 0, max: 10 }],
  },
  baseline: async () => 'baseline',
  fromResult: (result: DecisionResult) => {
    const answer = result.answers.get('__score');
    if (!answer || answer.kind !== 'score') return null;
    return { value: 'decision', confidence: answer.confidence };
  },
  ...over,
});

beforeEach(() => {
  resetDecisionTelemetryForTests();
});

describe('decision router', () => {
  it('uses the baseline unchanged when the site is not configured', async () => {
    const outcome = await runDecisionSite(input());
    expect(outcome).toEqual({ source: 'baseline', value: 'baseline' });
    expect(readDecisionTelemetry()).toEqual([]);
  });

  it('returns none without a baseline when there is no config', async () => {
    const outcome = await runDecisionSite(input({ baseline: undefined }));
    expect(outcome).toEqual({ source: 'none', reason: 'not-configured' });
  });

  it('never changes behavior in shadow mode', async () => {
    const baseline = vi.fn(async () => 'baseline');
    const outcome = await runDecisionSite(
      input({
        baseline,
        compare: () => true,
      }),
      {
        config: config({ mode: 'shadow' }),
        provider: provider({ answer: scoredAnswer(0.99) }),
      },
    );

    expect(outcome).toEqual({ source: 'baseline', value: 'baseline' });
    expect(baseline).toHaveBeenCalledTimes(1);
    expect(readDecisionTelemetry().map((entry) => entry.key)).toEqual([
      'quiz-grade|fake|shadow|shadow-agree',
    ]);
  });

  it('records a shadow disagreement and still returns the baseline', async () => {
    const outcome = await runDecisionSite(
      input({
        compare: () => false,
      }),
      {
        config: config({ mode: 'shadow' }),
        provider: provider({ answer: scoredAnswer(0.99) }),
      },
    );

    expect(outcome).toEqual({ source: 'baseline', value: 'baseline' });
    expect(readDecisionTelemetry()[0]?.key).toBe('quiz-grade|fake|shadow|shadow-disagree');
  });

  it('uses a high-confidence decision in triage mode', async () => {
    const outcome = await runDecisionSite(input(), {
      config: config({ mode: 'triage', minConfidence: 0.9 }),
      provider: provider({ answer: scoredAnswer(0.95) }),
    });

    expect(outcome).toEqual({ source: 'decision', value: 'decision', confidence: 0.95 });
    expect(readDecisionTelemetry()[0]?.key).toBe('quiz-grade|fake|triage|decision');
  });

  it('falls back in triage mode below the confidence threshold', async () => {
    const outcome = await runDecisionSite(input(), {
      config: config({ mode: 'triage', minConfidence: 0.9 }),
      provider: provider({ answer: scoredAnswer(0.4) }),
    });

    expect(outcome).toEqual({ source: 'baseline', value: 'baseline' });
    expect(readDecisionTelemetry()[0]?.key).toBe('quiz-grade|fake|triage|abstain');
  });

  it('uses a low-confidence decision in replace mode', async () => {
    const outcome = await runDecisionSite(input(), {
      config: config({ mode: 'replace' }),
      provider: provider({ answer: scoredAnswer(0.1) }),
    });

    expect(outcome).toEqual({ source: 'decision', value: 'decision', confidence: 0.1 });
  });

  it('falls back when the provider errors', async () => {
    const outcome = await runDecisionSite(input(), {
      config: config({ mode: 'replace' }),
      provider: provider({ fail: true }),
    });

    expect(outcome).toEqual({ source: 'baseline', value: 'baseline' });
    expect(readDecisionTelemetry()[0]?.key).toBe('quiz-grade|fake|replace|error');
  });

  it('skips a chat model in triage instead of paying for an unusable call', async () => {
    const decide = vi.fn();
    const outcome = await runDecisionSite(input(), {
      config: config({ provider: 'chat', model: 'ollama:qwen3:4b', mode: 'triage' }),
      provider: { id: 'fake', decide },
    });

    expect(outcome).toEqual({ source: 'baseline', value: 'baseline' });
    expect(decide).not.toHaveBeenCalled();
    expect(readDecisionTelemetry()[0]?.key).toBe('quiz-grade|fake|triage|skipped');
  });

  it('falls back when a provider cannot be constructed', async () => {
    const outcome = await runDecisionSite(input(), {
      config: config({ provider: 'laya', endpoint: undefined }),
    });

    expect(outcome).toEqual({ source: 'baseline', value: 'baseline' });
    expect(readDecisionTelemetry()[0]?.key).toBe('quiz-grade|laya|triage|error');
  });

  it('skips an input longer than the configured budget', async () => {
    const outcome = await runDecisionSite(input({ inputChars: 1_001 }), {
      config: config({ mode: 'replace' }),
      provider: provider({ answer: scoredAnswer(1) }),
    });

    expect(outcome).toEqual({ source: 'baseline', value: 'baseline' });
    expect(readDecisionTelemetry()[0]?.key).toBe('quiz-grade|fake|replace|skipped');
  });

  it('returns none when fallback is disabled and the decision abstains', async () => {
    const outcome = await runDecisionSite(input(), {
      config: config({ mode: 'replace', fallback: 'none' }),
      provider: provider({ answer: new Map() }),
    });

    expect(outcome).toEqual({ source: 'none', reason: 'no-answer' });
  });

  it('skips shadow mode without a baseline instead of paying for a call', async () => {
    const decide = vi.fn();
    const outcome = await runDecisionSite(input({ baseline: undefined }), {
      config: config({ mode: 'shadow' }),
      provider: { id: 'fake', decide },
    });

    expect(outcome).toEqual({ source: 'none', reason: 'no-baseline' });
    expect(decide).not.toHaveBeenCalled();
  });
});
