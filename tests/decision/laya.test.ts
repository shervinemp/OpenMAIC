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

  it('uses the Jev object wire format for Laya /v1/systemone', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ answers: {} }));
    const provider = createTypedHttpProvider(
      config({ endpoint: 'http://127.0.0.1:8000/v1/systemone/' }),
      { fetchImpl },
    );

    await provider.decide({
      state: 'The sky is blue.',
      questions: [
        {
          id: 'q1',
          kind: 'noul',
          prompt: 'Is the sky blue?',
        },
        {
          id: 'c1',
          kind: 'choice',
          prompt: 'Pick one',
          options: [{ value: 'A', label: 'Yes' }],
        },
        { id: 's1', kind: 'score', prompt: 'Score', min: 0, max: 2 },
      ],
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:8000/v1/systemone');
    expect(JSON.parse(String(init?.body))).toEqual({
      state: 'The sky is blue.',
      questions: {
        q1: { type: 'noul', instructions: 'Is the sky blue?' },
        c1: { type: 'choice', instructions: 'Pick one', criteria: { A: 'Yes' } },
        s1: { type: 'score', instructions: 'Score', criteria: ['0', '1', '2'] },
      },
    });
  });

  it('surfaces an HTTP failure without echoing the body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('learner answer leaked', { status: 500 }),
    );
    const provider = createTypedHttpProvider(config(), { fetchImpl, retryDelayMs: 0 });

    await expect(provider.decide({ state: 'x', questions: [] })).rejects.toThrow(
      'Decision server returned HTTP 500',
    );
  });

  it('retries one transient failure inside the same budget', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (fetchImpl.mock.calls.length === 1) return new Response('', { status: 503 });
      const body = JSON.parse(String(init?.body)) as { questions: Array<{ id: string }> };
      return Response.json({
        answers: { [body.questions[0]!.id]: { noul: 0.5, confidence: 0.9 } },
      });
    });
    const provider = createTypedHttpProvider(config(), { fetchImpl, retryDelayMs: 0 });

    const result = await provider.decide({
      state: 'x',
      questions: [{ id: 'q1', kind: 'noul', prompt: 'Is it?' }],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.answers.get('q1')).toMatchObject({ kind: 'noul', probability: 0.5 });
  });

  it('gives a repeated transient failure exactly one retry', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 503 }));
    const provider = createTypedHttpProvider(config(), { fetchImpl, retryDelayMs: 0 });

    await expect(
      provider.decide({ state: 'x', questions: [{ id: 'q1', kind: 'noul', prompt: 'Is it?' }] }),
    ).rejects.toThrow('Decision server returned HTTP 503');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a deterministic 4xx', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 400 }));
    const provider = createTypedHttpProvider(config(), { fetchImpl, retryDelayMs: 0 });

    await expect(provider.decide({ state: 'x', questions: [] })).rejects.toThrow(
      'Decision server returned HTTP 400',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an HTML response without retrying', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response('<html>not here</html>', { headers: { 'content-type': 'text/html' } }),
    );
    const provider = createTypedHttpProvider(config(), { fetchImpl, retryDelayMs: 0 });

    await expect(provider.decide({ state: 'x', questions: [] })).rejects.toThrow(
      'Decision server returned text/html instead of JSON',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized declared body before reading it', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response('{}', {
          headers: { 'content-type': 'application/json', 'content-length': '2048' },
        }),
    );
    const provider = createTypedHttpProvider(config(), {
      fetchImpl,
      retryDelayMs: 0,
      maxResponseBytes: 1024,
    });

    await expect(provider.decide({ state: 'x', questions: [] })).rejects.toThrow(
      'Decision response exceeded the size cap',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized streamed body with no content-length', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response('x'.repeat(2_048), { headers: { 'content-type': 'application/json' } }),
    );
    const provider = createTypedHttpProvider(config(), {
      fetchImpl,
      retryDelayMs: 0,
      maxResponseBytes: 1024,
    });

    await expect(provider.decide({ state: 'x', questions: [] })).rejects.toThrow(
      'Decision response exceeded the size cap',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries malformed JSON once, then fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('{not json', { headers: { 'content-type': 'application/json' } }),
    );
    const provider = createTypedHttpProvider(config(), { fetchImpl, retryDelayMs: 0 });

    await expect(provider.decide({ state: 'x', questions: [] })).rejects.toThrow(
      'Decision server returned invalid JSON',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
