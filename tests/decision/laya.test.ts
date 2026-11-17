import { describe, expect, it, vi } from 'vitest';

import { createTypedHttpProvider } from '@/lib/decision/providers/laya';
import type { DecisionSiteConfig } from '@/lib/decision/types';

function config(over: Partial<DecisionSiteConfig> = {}): DecisionSiteConfig {
  return {
    site: 'quiz-verify',
    provider: 'laya',
    mode: 'replace',
    endpoint: 'http://127.0.0.1:8090',
    timeoutMs: 2_000,
    minConfidence: 0.9,
    maxInputChars: 10_000,
    fallback: 'llm',
    ...over,
  };
}

describe('typed decision HTTP provider', () => {
  it('posts state and typed questions, then normalizes answers', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        answers: {
          q1: { choice: 'A', confidence: 0.94 },
          s1: { score: 7, confidence: 0.8 },
        },
      }),
    );

    const provider = createTypedHttpProvider(config(), { fetchImpl });
    const result = await provider.decide({
      state: 'Blind solve',
      questions: [
        {
          id: 'q1',
          kind: 'choice',
          prompt: 'Which option?',
          options: [
            { value: 'A', label: 'Right' },
            { value: 'B', label: 'Wrong' },
          ],
        },
        { id: 's1', kind: 'score', prompt: 'Score it', min: 0, max: 10 },
      ],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:8090/predict');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      state: 'Blind solve',
      questions: [
        { id: 'q1', type: 'choice', prompt: 'Which option?', multiple: false },
        { id: 's1', type: 'score', min: 0, max: 10 },
      ],
    });
    expect(result.provider).toBe('laya');
    expect(result.answers.get('q1')).toMatchObject({ kind: 'choice', values: ['A'] });
    expect(result.answers.get('s1')).toMatchObject({ kind: 'score', value: 7 });
  });

  it('does not duplicate a /predict suffix and sends a bearer key', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ answers: {} }));
    const provider = createTypedHttpProvider(
      config({ endpoint: 'http://127.0.0.1:8090/predict', apiKey: 'secret' }),
      { fetchImpl },
    );

    await provider.decide({ state: 'x', questions: [] });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:8090/predict');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret');
  });

  it('surfaces an HTTP failure without echoing the body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('learner answer leaked', { status: 500 }),
    );
    const provider = createTypedHttpProvider(config(), { fetchImpl });

    await expect(provider.decide({ state: 'x', questions: [] })).rejects.toThrow(
      'Decision server returned HTTP 500',
    );
  });
});
