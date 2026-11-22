import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverOpenCodeModels,
  isOpenCodeGatewayBaseUrl,
  rankOpenCodeModels,
  resolveOpenCodeDefaultModel,
} from '@/lib/server/opencode-models';

const ORIGINAL_PREFIX = process.env.OPENCODE_MODEL_PREFIX;
const ORIGINAL_MODELS = process.env.OPENROUTER_MODELS;

afterEach(() => {
  if (ORIGINAL_PREFIX === undefined) delete process.env.OPENCODE_MODEL_PREFIX;
  else process.env.OPENCODE_MODEL_PREFIX = ORIGINAL_PREFIX;
  if (ORIGINAL_MODELS === undefined) delete process.env.OPENROUTER_MODELS;
  else process.env.OPENROUTER_MODELS = ORIGINAL_MODELS;
});

describe('OpenCode gateway detection', () => {
  it('matches the local bridge and opencode.ai gateways', () => {
    expect(isOpenCodeGatewayBaseUrl('http://127.0.0.1:8787/v1')).toBe(true);
    expect(isOpenCodeGatewayBaseUrl('http://localhost:8787/v1')).toBe(true);
    expect(isOpenCodeGatewayBaseUrl('https://opencode.ai/inference/go/v1')).toBe(true);
    expect(isOpenCodeGatewayBaseUrl('https://opencode.ai/zen/v1')).toBe(true);
  });

  it('does not match unrelated providers', () => {
    expect(isOpenCodeGatewayBaseUrl('https://api.openrouter.ai/api/v1')).toBe(false);
    expect(isOpenCodeGatewayBaseUrl('http://127.0.0.1:8080/v1')).toBe(false);
    expect(isOpenCodeGatewayBaseUrl(undefined)).toBe(false);
  });
});

describe('rankOpenCodeModels', () => {
  it('prefers the qualified id and drops its ambiguous bare twin', () => {
    const ranked = rankOpenCodeModels([
      'hy4-flash-free',
      'opencode-go/hy4-flash-free',
      'opencode/hy4-flash-free',
    ]);
    expect(ranked[0]).toBe('opencode-go/hy4-flash-free');
    expect(ranked).not.toContain('hy4-flash-free');
  });

  it('excludes non-chat models', () => {
    const ranked = rankOpenCodeModels([
      'opencode-go/kokoro-tts',
      'opencode-go/hy4-flash-free',
      'opencode-go/image-gen',
    ]);
    expect(ranked).toEqual(['opencode-go/hy4-flash-free']);
  });

  it('ranks qualified ids above bare ones and drops ambiguous bare twins', () => {
    const ranked = rankOpenCodeModels([
      'hy4-flash-free',
      'tencent/hy4-flash',
      'tencent/hy4-flash-free',
      'plain-model',
    ]);
    expect(ranked[0]).toBe('tencent/hy4-flash');
    expect(ranked).not.toContain('hy4-flash-free');
    expect(ranked).toContain('plain-model');
  });

  it('honors a custom preferred prefix', () => {
    process.env.OPENCODE_MODEL_PREFIX = 'opencode/';
    const ranked = rankOpenCodeModels(['opencode-go/hy4-flash-free', 'opencode/hy4-flash-free']);
    expect(ranked[0]).toBe('opencode/hy4-flash-free');
  });

  it('is deterministic and dedupes', () => {
    const ids = ['opencode-go/b', 'opencode-go/a', 'opencode-go/a', 'other-model'];
    expect(rankOpenCodeModels(ids)).toEqual([
      'opencode-go/a',
      'opencode-go/b',
      'other-model',
    ]);
  });
});

describe('discoverOpenCodeModels', () => {
  const baseUrl = 'http://127.0.0.1:8787/v1';

  it('lists, filters and ranks models from the gateway', async () => {
    const models = await discoverOpenCodeModels({
      baseUrl,
      listModels: async () => [
        { id: 'hy4-flash-free' },
        { id: 'opencode-go/hy4-flash-free' },
      ],
    });
    expect(models).toEqual(['opencode-go/hy4-flash-free']);
  });

  it('fails open when the catalog is unavailable', async () => {
    const models = await discoverOpenCodeModels({
      baseUrl,
      listModels: async () => {
        throw new Error('bridge down');
      },
    });
    expect(models).toEqual([]);
    expect(
      await resolveOpenCodeDefaultModel({
        baseUrl,
        listModels: async () => {
          throw new Error('bridge down');
        },
      }),
    ).toBeUndefined();
  });

  it('does not probe a non-OpenCode base URL', async () => {
    let called = false;
    const models = await discoverOpenCodeModels({
      baseUrl: 'https://api.openai.com/v1',
      listModels: async () => {
        called = true;
        return [{ id: 'gpt-5' }];
      },
    });
    expect(called).toBe(false);
    expect(models).toEqual([]);
  });
});
