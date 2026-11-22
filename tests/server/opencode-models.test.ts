import { describe, expect, it } from 'vitest';

import { getProvider } from '@/lib/ai/providers';
import {
  discoverOpenCodeModels,
  rankOpenCodeModels,
  resolveOpenCodeDefaultModel,
} from '@/lib/server/opencode-models';

describe('native OpenCode provider', () => {
  it('is registered with no hardcoded models and a local bridge default', () => {
    const provider = getProvider('opencode');
    expect(provider).toMatchObject({
      id: 'opencode',
      type: 'openai',
      defaultBaseUrl: 'http://127.0.0.1:8787/v1',
      requiresApiKey: false,
      supportsModelDiscovery: true,
    });
    expect(provider?.models).toEqual([]);
  });
});

describe('rankOpenCodeModels', () => {
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

  it('excludes non-chat models', () => {
    expect(
      rankOpenCodeModels(['opencode-go/kokoro-tts', 'opencode-go/hy4-flash', 'image-gen']),
    ).toEqual(['opencode-go/hy4-flash']);
  });

  it('is deterministic and dedupes', () => {
    expect(rankOpenCodeModels(['p/b', 'p/a', 'p/a', 'other'])).toEqual(['p/a', 'p/b', 'other']);
  });
});

describe('discoverOpenCodeModels', () => {
  const baseUrl = 'http://127.0.0.1:8787/v1';

  it('lists, filters and ranks models from the provider base URL', async () => {
    const models = await discoverOpenCodeModels({
      baseUrl,
      listModels: async () => [
        { id: 'hy4-flash-free' },
        { id: 'tencent/hy4-flash' },
        { id: 'tencent/hy4-flash-free' },
      ],
    });
    expect(models).toEqual(['tencent/hy4-flash', 'tencent/hy4-flash-free']);
  });

  it('returns a native opencode: default model string', async () => {
    expect(
      await resolveOpenCodeDefaultModel({
        baseUrl,
        listModels: async () => [{ id: 'tencent/hy4-flash' }],
      }),
    ).toBe('opencode:tencent/hy4-flash');
  });

  it('fails open when the catalog is unavailable', async () => {
    const failing = {
      baseUrl,
      listModels: async () => {
        throw new Error('bridge down');
      },
    };
    expect(await discoverOpenCodeModels(failing)).toEqual([]);
    expect(await resolveOpenCodeDefaultModel(failing)).toBeUndefined();
  });

  it('does nothing without a base URL', async () => {
    let called = false;
    const models = await discoverOpenCodeModels({
      baseUrl: '',
      listModels: async () => {
        called = true;
        return [{ id: 'gpt-5' }];
      },
    });
    expect(called).toBe(false);
    expect(models).toEqual([]);
  });
});
