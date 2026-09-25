import { describe, expect, it } from 'vitest';
import { getCachedTTS, setCachedTTS, ttsCacheKey } from '@/lib/audio/tts-cache';

describe('tts-cache', () => {
  it('keys deterministically and distinguishes input changes', () => {
    const base = {
      text: 'hello',
      providerId: 'openai',
      modelId: 'tts-1',
      voice: 'alloy',
      speed: 1.0,
    };
    expect(ttsCacheKey(base)).toBe(ttsCacheKey({ ...base }));
    expect(ttsCacheKey({ ...base, text: 'goodbye' })).not.toBe(ttsCacheKey(base));
    expect(ttsCacheKey({ ...base, voice: 'echo' })).not.toBe(ttsCacheKey(base));
    expect(ttsCacheKey({ ...base, speed: 1.5 })).not.toBe(ttsCacheKey(base));
    expect(ttsCacheKey(base)).not.toBe(
      ttsCacheKey({ ...base, providerOptions: { voicePrompt: 'x' } }),
    );
  });

  it('separates tenants by apiKey and baseUrl so cached audio is never cross-served', () => {
    const base = {
      text: 'hello',
      providerId: 'lemonade',
      voice: 'en_us_heart',
      speed: 1.0,
    };
    expect(ttsCacheKey({ ...base, apiKey: 'tenant-a', baseUrl: 'http://host-a' })).not.toBe(
      ttsCacheKey({ ...base, apiKey: 'tenant-b', baseUrl: 'http://host-a' }),
    );
    expect(ttsCacheKey({ ...base, apiKey: 'tenant-a', baseUrl: 'http://host-a' })).not.toBe(
      ttsCacheKey({ ...base, apiKey: 'tenant-a', baseUrl: 'http://host-b' }),
    );
  });

  it('round-trips a cached audio entry', () => {
    const key = ttsCacheKey({
      text: 'cache me',
      providerId: 'openai',
      voice: 'alloy',
      speed: 1.0,
    });
    expect(getCachedTTS(key)).toBeUndefined();
    setCachedTTS(key, { base64: 'abc', format: 'mp3' });
    expect(getCachedTTS(key)).toEqual({ base64: 'abc', format: 'mp3' });
  });
});
