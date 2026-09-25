import { describe, expect, it } from 'vitest';

import { mergeSettings, sanitizeValue } from '@/lib/backup/full-backup';

describe('sanitizeValue', () => {
  it('strips credentials from nested provider configs', () => {
    const input = {
      providersConfig: {
        openai: { model: 'gpt-5', apiKey: 'sk-abc', baseUrl: 'http://x' },
        custom: { name: 'local', apiKey: 'secret', api_base: 'http://y' },
      },
      ttsProvidersConfig: { kokoro: { apiKey: 'k', enabled: true } },
    };
    const out = sanitizeValue(input) as Record<string, unknown> & {
      providersConfig: Record<string, Record<string, unknown>>;
    };
    expect(out.providersConfig.openai).not.toHaveProperty('apiKey');
    expect(out.providersConfig.openai).toHaveProperty('model', 'gpt-5');
    expect(out.ttsProvidersConfig).toStrictEqual({ kokoro: { enabled: true } });
  });

  it('strips access keys and secrets', () => {
    const out = sanitizeValue({ accessKeyId: 'AK', accessKeySecret: 'SK', token: 't' }) as Record<
      string,
      unknown
    >;
    expect(out).toEqual({});
  });

  it('keeps ordinary settings untouched', () => {
    const out = sanitizeValue({ ttsVoice: 'af_heart', speed: 1.2 }) as Record<string, unknown>;
    expect(out).toEqual({ ttsVoice: 'af_heart', speed: 1.2 });
  });
});

describe('mergeSettings', () => {
  it('keeps live credentials that a sanitized backup omits', () => {
    const live = { ttsProvidersConfig: { kokoro: { apiKey: 'live-key', voice: 'af_heart' } } };
    const backup = sanitizeValue({
      ttsProvidersConfig: { kokoro: { apiKey: 'secret', voice: 'am_michael' } },
    }) as Record<string, unknown>;
    const merged = mergeSettings(live, backup) as Record<
      string,
      { kokoro: { apiKey: string; voice: string } }
    >;
    expect(merged.ttsProvidersConfig.kokoro.apiKey).toBe('live-key');
    expect(merged.ttsProvidersConfig.kokoro.voice).toBe('am_michael');
  });

  it('merges arrays element-wise without dropping existing entries', () => {
    const live = { customProviders: [{ id: 'a', apiKey: 'keep', name: 'A' }] };
    const backup = sanitizeValue({
      customProviders: [
        { id: 'a', name: 'Aw' },
        { id: 'b', name: 'B' },
      ],
    }) as unknown;
    const merged = mergeSettings(live, backup) as {
      customProviders: Array<{ id: string; apiKey?: string; name: string }>;
    };
    expect(merged.customProviders).toHaveLength(2);
    expect(merged.customProviders[0]).toMatchObject({ id: 'a', name: 'Aw', apiKey: 'keep' });
    expect(merged.customProviders[1]).toMatchObject({ id: 'b', name: 'B' });
  });

  it('prefers backup scalars over live values', () => {
    const merged = mergeSettings({ ttsSpeed: 1.0, enabled: false }, { enabled: true }) as Record<
      string,
      unknown
    >;
    expect(merged).toMatchObject({ ttsSpeed: 1.0, enabled: true });
  });
});
