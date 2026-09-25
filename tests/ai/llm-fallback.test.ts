import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const generateTextMock = vi.hoisted(() => vi.fn());
const resolveModelMock = vi.hoisted(() => vi.fn());

vi.mock('ai', () => ({
  generateText: generateTextMock,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModel: resolveModelMock,
}));

import { callLLM } from '@/lib/ai/llm';
import type { LanguageModel } from 'ai';

const asModel = (m: unknown) => m as LanguageModel;

describe('callLLM provider fallback', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    resolveModelMock.mockReset();
    vi.stubEnv('OPENMAIC_FALLBACK_MODEL', 'deepseek:deepseek-v4-flash');
    const fallbackModel = { provider: 'deepseek', modelId: 'deepseek-v4-flash' };
    resolveModelMock.mockResolvedValue({ model: fallbackModel });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test('retries once on the fallback model when the primary fails with a provider error', async () => {
    const primaryModel = { provider: 'openrouter', modelId: 'x-preview-f-free' };
    generateTextMock
      .mockRejectedValueOnce(new Error('Error from provider: Endpoint is unavailable'))
      .mockResolvedValueOnce({ text: 'fallback ok', usage: {} });

    const result = await callLLM(
      { model: asModel(primaryModel), prompt: 'hi' },
      'fallback-test',
    );

    expect(result.text).toBe('fallback ok');
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    // The second call swapped in the resolved fallback model.
    const secondCall = generateTextMock.mock.calls[1][0] as { model?: unknown };
    expect(secondCall.model).toEqual({ provider: 'deepseek', modelId: 'deepseek-v4-flash' });
    expect(resolveModelMock).toHaveBeenCalledWith({
      modelString: 'deepseek:deepseek-v4-flash',
    });
  });

  test('does not fall back on abort errors', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    generateTextMock.mockRejectedValue(abort);

    await expect(callLLM({ model: asModel({ provider: 'x' }), prompt: 'hi' }, 'fallback-test')).rejects.toThrow(
      'Aborted',
    );
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(resolveModelMock).not.toHaveBeenCalled();
  });

  test('does not fall back when no fallback model is configured', async () => {
    vi.stubEnv('OPENMAIC_FALLBACK_MODEL', '');
    generateTextMock.mockRejectedValue(new Error('Insufficient Balance'));

    await expect(callLLM({ model: asModel({ provider: 'x' }), prompt: 'hi' }, 'fallback-test')).rejects.toThrow(
      'Insufficient Balance',
    );
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  test('non-provider errors exhaust the normal budget without swapping', async () => {
    generateTextMock.mockRejectedValue(new Error('Invalid schema'));

    await expect(
      callLLM({ model: asModel({ provider: 'x' }), prompt: 'hi' }, 'fallback-test', { retries: 1 }),
    ).rejects.toThrow('Invalid schema');
    // 2 attempts (retries=1), both on the primary model.
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(resolveModelMock).not.toHaveBeenCalled();
  });

  test('fallback failure propagates after the single swap', async () => {
    const primaryModel = { provider: 'openrouter', modelId: 'x-preview-f-free' };
    generateTextMock.mockRejectedValue(new Error('Insufficient Balance'));

    await expect(
      callLLM({ model: asModel(primaryModel), prompt: 'hi' }, 'fallback-test'),
    ).rejects.toThrow('Insufficient Balance');
    // Primary attempt + one fallback attempt, then the error propagates.
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });
});

