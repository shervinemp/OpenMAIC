import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRetryableGenerationError } from '@openmaic/generation';

const aiMock = vi.hoisted(() => ({ generateText: vi.fn(), streamText: vi.fn() }));
const usageMock = vi.hoisted(() => ({
  normalizeUsage: vi.fn((usage: unknown) => usage),
  recordUsage: vi.fn(async () => undefined),
}));
const fallbackMock = vi.hoisted(() => ({
  resolveFallbackModel: vi.fn(),
  isRetryableLlmError: vi.fn(),
  shouldFallbackFor: vi.fn(),
  logFallbackFired: vi.fn(),
  isEmptyLlmOutput: vi.fn((text: string | null | undefined) => !text || text.trim().length === 0),
}));

vi.mock('ai', () => ({
  generateText: aiMock.generateText,
  streamText: aiMock.streamText,
}));
vi.mock('@/lib/usage/normalize', () => ({ normalizeUsage: usageMock.normalizeUsage }));
vi.mock('@/lib/server/usage-storage', () => ({ recordUsage: usageMock.recordUsage }));
vi.mock('@/lib/server/llm-fallback', () => fallbackMock);

import { LlmOutputTruncatedError, callLLM, isLlmOutputTruncatedError } from '@/lib/ai/llm';

function result(finishReason: string, text = 'partial output') {
  return {
    text,
    finishReason,
    usage: {},
    totalUsage: {},
    sources: [],
    steps: [],
  } as never;
}

describe('callLLM output truncation', () => {
  beforeEach(() => {
    aiMock.generateText.mockReset();
    fallbackMock.resolveFallbackModel.mockReset();
    fallbackMock.shouldFallbackFor.mockReset();
    fallbackMock.logFallbackFired.mockReset();
    fallbackMock.resolveFallbackModel.mockResolvedValue(null);
    fallbackMock.shouldFallbackFor.mockReturnValue(true);
  });

  it('rejects a length finish instead of returning a truncated result', async () => {
    aiMock.generateText.mockResolvedValue(result('length'));

    const error = await callLLM(
      {
        model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never,
        prompt: 'write the deck',
        maxOutputTokens: 24_000,
      } as never,
      'scene-content',
    ).catch((caught: unknown) => caught);

    expect(isLlmOutputTruncatedError(error)).toBe(true);
    expect(error).toBeInstanceOf(LlmOutputTruncatedError);
    expect((error as LlmOutputTruncatedError).maxOutputTokens).toBe(24_000);
    expect((error as LlmOutputTruncatedError).text).toBe('partial output');
    expect((error as LlmOutputTruncatedError).message).toContain('truncated');
    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
  });

  it('does not retry the same cap or arm the fallback model', async () => {
    aiMock.generateText.mockResolvedValue(result('length'));

    await expect(
      callLLM(
        {
          model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never,
          prompt: 'write the deck',
          maxOutputTokens: 8_000,
        } as never,
        'scene-content',
        { retries: 2 },
        undefined,
        { serverManaged: true },
      ),
    ).rejects.toBeInstanceOf(LlmOutputTruncatedError);

    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
    expect(fallbackMock.shouldFallbackFor).not.toHaveBeenCalled();
  });

  it('marks truncation non-retryable for the generation retry helper', async () => {
    aiMock.generateText.mockResolvedValue(result('length'));

    const error = await callLLM(
      {
        model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never,
        prompt: 'write the deck',
      } as never,
      'scene-content',
    ).catch((caught: unknown) => caught);

    expect(isRetryableGenerationError(error)).toBe(false);
  });

  it('still returns a complete result', async () => {
    aiMock.generateText.mockResolvedValue(result('stop', 'complete output'));

    const complete = await callLLM(
      {
        model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never,
        prompt: 'write the deck',
      } as never,
      'scene-content',
    );

    expect(complete.text).toBe('complete output');
    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
  });
});
