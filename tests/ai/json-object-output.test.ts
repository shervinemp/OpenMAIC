import { beforeEach, describe, expect, it, vi } from 'vitest';

const openAiMock = vi.hoisted(() => ({
  chat: vi.fn((modelId: string) => ({ endpoint: 'chat', modelId })),
  responses: vi.fn((modelId: string) => ({ endpoint: 'responses', modelId })),
  createOpenAI: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: openAiMock.createOpenAI,
}));

vi.mock('@ai-sdk/azure', () => ({
  createAzure: vi.fn(),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    wrapLanguageModel: vi.fn(({ model }) => model),
    extractReasoningMiddleware: vi.fn(() => ({})),
  };
});

import { withJsonObjectOutput } from '@/lib/ai/json-output-context';
import { getModel } from '@/lib/ai/providers';
import type { ModelConfig } from '@/lib/ai/providers';

const CHAT_URL = 'http://127.0.0.1:11434/v1/chat/completions';

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Build one model through the real provider factory with a fake transport.
 *
 * `getModel` is the seam that installs the compat fetch; calling the captured
 * `options.fetch` is exactly what the AI SDK does at request time, without
 * needing a live server.
 */
async function captureRequest(input: {
  model?: Partial<ModelConfig>;
  insideJsonContext?: boolean;
  url?: string;
  body?: Record<string, unknown>;
}): Promise<CapturedRequest> {
  const calls: CapturedRequest[] = [];
  const fetchImpl = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(request),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  getModel({
    providerId: 'ollama',
    modelId: 'qwen3:4b',
    apiKey: '',
    fetchImpl,
    ...input.model,
  });

  const options = openAiMock.createOpenAI.mock.calls.at(-1)?.[0] as
    | { fetch?: typeof fetch }
    | undefined;
  if (!options?.fetch) throw new Error('compat fetch was not installed');

  const send = () =>
    options.fetch!(input.url ?? CHAT_URL, {
      method: 'POST',
      body: JSON.stringify(
        input.body ?? {
          model: 'qwen3:4b',
          messages: [{ role: 'user', content: 'answer as JSON' }],
        },
      ),
    });

  if (input.insideJsonContext) await withJsonObjectOutput(send);
  else await send();

  const captured = calls[0];
  if (!captured) throw new Error('no request was sent');
  return captured;
}

beforeEach(() => {
  openAiMock.chat.mockClear();
  openAiMock.responses.mockClear();
  openAiMock.createOpenAI.mockReset();
  openAiMock.createOpenAI.mockReturnValue({
    chat: openAiMock.chat,
    responses: openAiMock.responses,
  });
});

describe('decoder-enforced JSON output', () => {
  it('leaves the request untouched when no JSON output was requested', async () => {
    const request = await captureRequest({});
    expect(request.body.response_format).toBeUndefined();
  });

  it('adds response_format json_object inside the opt-in context', async () => {
    const request = await captureRequest({ insideJsonContext: true });
    expect(request.body.response_format).toEqual({ type: 'json_object' });
    // The rest of the body still reaches the provider unchanged.
    expect(request.body.model).toBe('qwen3:4b');
    expect(request.body.messages).toBeDefined();
  });

  it('preserves an explicit response_format from the caller', async () => {
    const explicit = { type: 'json_schema', json_schema: { name: 'answers', schema: {} } };
    const request = await captureRequest({
      insideJsonContext: true,
      body: { model: 'qwen3:4b', messages: [], response_format: explicit },
    });
    expect(request.body.response_format).toEqual(explicit);
  });

  it('does not touch non-chat-completions requests', async () => {
    const request = await captureRequest({
      insideJsonContext: true,
      url: 'http://127.0.0.1:11434/v1/embeddings',
    });
    expect(request.body.response_format).toBeUndefined();
  });

  it('applies to the native OpenAI chat path too', async () => {
    const request = await captureRequest({
      model: {
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        apiKey: 'sk-test',
      },
      insideJsonContext: true,
      url: 'https://api.openai.com/v1/chat/completions',
    });
    expect(request.body.response_format).toEqual({ type: 'json_object' });
  });
});
