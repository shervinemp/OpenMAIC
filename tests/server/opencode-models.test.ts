import { describe, expect, it } from 'vitest';

import { getProvider } from '@/lib/ai/providers';
import {
  discoverOpenCodeModels,
  qualifyDuplicateModels,
  rankOpenCodeModels,
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

describe('qualifyDuplicateModels', () => {
  it('exposes owner-qualified variants for ids that collide across owners', () => {
    const ids = qualifyDuplicateModels([
      { id: 'hy4-flash-free', ownedBy: 'opencode' },
      { id: 'hy4-flash-free', ownedBy: 'opencode-go' },
      { id: 'tencent/hy4-flash', ownedBy: 'openrouter' },
    ]);
    expect(ids).toContain('opencode-go/hy4-flash-free');
    expect(ids).toContain('opencode/hy4-flash-free');
    expect(ids).not.toContain('hy4-flash-free');
    expect(rankOpenCodeModels(ids)[0]).toBe('opencode-go/hy4-flash-free');
  });

  it('leaves unambiguous ids alone', () => {
    expect(qualifyDuplicateModels([{ id: 'openai/gpt-5', ownedBy: 'openai' }])).toEqual([
      'openai/gpt-5',
    ]);
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

  it('uses the supplied base URL for discovery', async () => {
    const seen: string[] = [];
    await discoverOpenCodeModels({
      baseUrl: 'https://opencode.ai/go/v1',
      listModels: async (url) => {
        seen.push(url);
        return [{ id: 'some/model' }];
      },
    });
    expect(seen).toEqual(['https://opencode.ai/go/v1']);
  });

  it('fails open when the catalog is unavailable', async () => {
    expect(
      await discoverOpenCodeModels({
        baseUrl,
        listModels: async () => {
          throw new Error('bridge down');
        },
      }),
    ).toEqual([]);
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
