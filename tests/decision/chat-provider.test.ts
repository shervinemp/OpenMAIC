import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
}));

import { createChatDecisionProvider } from '@/lib/decision/providers/chat';
import type { DecisionSiteConfig } from '@/lib/decision/types';
import type { resolveModel } from '@/lib/server/resolve-model';

function config(over: Partial<DecisionSiteConfig> = {}): DecisionSiteConfig {
  return {
    site: 'quiz-grade',
    provider: 'chat',
    model: 'ollama:qwen3:4b',
    mode: 'replace',
    timeoutMs: 2_000,
    minConfidence: 0.9,
    maxInputChars: 8_000,
    fallback: 'llm',
    ...over,
  };
}

const resolve = (async () => ({
  model: 'ollama:qwen3:4b',
  modelString: 'ollama:qwen3:4b',
  modelInfo: { outputWindow: 8_000 },
  thinkingConfig: undefined,
  serverManaged: true,
})) as unknown as typeof resolveModel;

describe('chat decision provider', () => {
  it('asks any registry model for the same typed JSON shape', async () => {
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify({ answers: { __score: { score: 7, confidence: 0.93 } } }),
    });
    const provider = createChatDecisionProvider(config(), { resolve });

    const result = await provider.decide({
      state: 'QUESTION: ...\nSTUDENT ANSWER: ...',
      questions: [{ id: '__score', kind: 'score', prompt: 'Score', min: 0, max: 10 }],
    });

    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    const [params, source] = mocks.callLLM.mock.calls[0]!;
    expect(source).toBe('decision:quiz-grade');
    expect(params).toMatchObject({ temperature: 0, maxOutputTokens: 1_200 });
    expect(String(params.system)).toContain('typed decision engine');
    expect(String(params.prompt)).toContain('__score');
    expect(result.answers.get('__score')).toMatchObject({ kind: 'score', value: 7 });
    expect(result.provider).toBe('chat:ollama:qwen3:4b');
  });

  it('returns no answer for an unparseable reply so the router can fall back', async () => {
    mocks.callLLM.mockResolvedValue({ text: 'I think it is a seven.' });
    const provider = createChatDecisionProvider(config(), { resolve });

    const result = await provider.decide({
      state: 'x',
      questions: [{ id: '__score', kind: 'score', prompt: 'Score', min: 0, max: 10 }],
    });

    expect(result.answers.size).toBe(0);
    expect(result.abstained.has('__score')).toBe(true);
  });
});
