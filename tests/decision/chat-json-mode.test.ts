import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModel, type ModelWithInfo } from '@/lib/ai/providers';
import { createChatDecisionProvider } from '@/lib/decision/providers/chat';
import type { DecisionSiteConfig } from '@/lib/decision/types';
import type { resolveModel } from '@/lib/server/resolve-model';

/**
 * End-to-end chat-decision test: a real local HTTP server stands in for an
 * OpenAI-compatible endpoint, so the assertion is on the wire body the
 * transport actually sent — not on an internal helper.
 */

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let model: ModelWithInfo;
let requests: Array<Record<string, unknown>> = [];

const ANSWER = JSON.stringify({ answers: { q1: { noul: 0.82 } } });

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      try {
        requests.push(JSON.parse(text) as Record<string, unknown>);
      } catch {
        requests.push({ raw: text });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1,
          model: 'qwen3:4b',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: ANSWER },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
  model = getModel({
    providerId: 'ollama',
    modelId: 'qwen3:4b',
    apiKey: '',
    baseUrl,
  });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
});

function config(over: Partial<DecisionSiteConfig> = {}): DecisionSiteConfig {
  return {
    site: 'quiz-grade',
    provider: 'chat',
    model: 'ollama:qwen3:4b',
    mode: 'replace',
    timeoutMs: 5_000,
    minConfidence: 0.9,
    maxInputChars: 8_000,
    fallback: 'llm',
    ...over,
  };
}

const resolve = (async () => ({
  model: model.model,
  modelInfo: model.modelInfo,
  modelString: 'ollama:qwen3:4b',
  providerId: 'ollama',
  modelId: 'qwen3:4b',
  apiKey: '',
  baseUrl,
  thinkingConfig: undefined,
  serverManaged: false,
})) as unknown as typeof resolveModel;

const request = {
  state: 'STATE',
  questions: [{ id: 'q1', kind: 'noul' as const, prompt: 'Is it?' }],
};

describe('chat decision JSON mode over a real endpoint', () => {
  it('sends response_format json_object when the site opts in', async () => {
    const provider = createChatDecisionProvider(config({ jsonMode: true }), { resolve });
    const result = await provider.decide(request);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.response_format).toEqual({ type: 'json_object' });
    expect(result.answers.get('q1')).toMatchObject({ kind: 'noul', probability: 0.82 });
  });

  it('leaves the wire body unchanged without the opt-in', async () => {
    const provider = createChatDecisionProvider(config(), { resolve });
    await provider.decide(request);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.response_format).toBeUndefined();
  });
});
