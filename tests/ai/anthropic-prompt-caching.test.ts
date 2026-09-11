import { afterEach, describe, expect, it } from 'vitest';
import { injectAnthropicSystemCacheControl, wrapAnthropicCacheFetch } from '@/lib/ai/providers';

describe('injectAnthropicSystemCacheControl', () => {
  it('wraps a string system prompt into an ephemeral cache block', () => {
    const body = { system: 'You are a helpful tutor.', messages: [] };
    const result = injectAnthropicSystemCacheControl(body) as {
      system: Array<{ type: string; text: string; cache_control: { type: string } }>;
    };
    expect(result.system).toEqual([
      { type: 'text', text: 'You are a helpful tutor.', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('tags the last block of an array system prompt without touching earlier blocks', () => {
    const body = {
      system: [
        { type: 'text', text: 'stable prefix' },
        { type: 'text', text: 'tail' },
      ],
    };
    const result = injectAnthropicSystemCacheControl(body) as {
      system: Array<{ cache_control?: unknown }>;
    };
    expect(result.system[0]).not.toHaveProperty('cache_control');
    expect(result.system[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('never overwrites an existing cache_control', () => {
    const body = {
      system: [{ type: 'text', text: 'already tagged', cache_control: { type: 'ephemeral' } }],
    };
    const result = injectAnthropicSystemCacheControl(body) as {
      system: Array<{ cache_control?: unknown }>;
    };
    expect((result.system as Array<{ cache_control?: unknown }>)[0].cache_control).toEqual({
      type: 'ephemeral',
    });
  });

  it('leaves bodies without a system prompt untouched', () => {
    const body = { messages: [] };
    expect(injectAnthropicSystemCacheControl(body)).toBe(body);
    expect(injectAnthropicSystemCacheControl(null)).toBeNull();
  });
});

describe('wrapAnthropicCacheFetch', () => {
  afterEach(() => {
    delete process.env.LLM_PROMPT_CACHING_DISABLED;
  });

  it('rewrites the request body with a cache block and forwards the call', async () => {
    let seen: string | undefined;
    const response = new Response('{}');
    const fetch = wrapAnthropicCacheFetch(async (_url, init) => {
      seen = (init?.body as string) ?? undefined;
      return response;
    });
    const result = await fetch('http://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ system: 'stable prefix', messages: [] }),
    });
    expect(result).toBe(response);
    expect(JSON.parse(seen ?? '{}').system).toEqual([
      { type: 'text', text: 'stable prefix', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('respects the LLM_PROMPT_CACHING_DISABLED opt-out', async () => {
    process.env.LLM_PROMPT_CACHING_DISABLED = 'true';
    let seen: string | undefined;
    const fetch = wrapAnthropicCacheFetch(async (_url, init) => {
      seen = (init?.body as string) ?? undefined;
      return new Response('{}');
    });
    await fetch('http://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ system: 'stable prefix' }),
    });
    expect(JSON.parse(seen ?? '{}').system).toBe('stable prefix');
  });

  it('passes through requests with an unparseable body unchanged', async () => {
    let seen: string | undefined;
    const fetch = wrapAnthropicCacheFetch(async (_url, init) => {
      seen = (init?.body as string) ?? undefined;
      return new Response('{}');
    });
    await fetch('http://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: 'not-json',
    });
    expect(seen).toBe('not-json');
  });
});
