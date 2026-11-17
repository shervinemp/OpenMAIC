import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  decisionModelsEnabled,
  getDecisionSiteConfig,
  parseDecisionRoutes,
  resetDecisionConfigForTests,
} from '@/lib/decision/config';

const originalRoutes = process.env.DECISION_ROUTES;
const originalEnabled = process.env.DECISION_MODELS_ENABLED;
const originalJevKey = process.env.JEV_API_KEY;

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...over } as NodeJS.ProcessEnv;
}

beforeEach(() => {
  resetDecisionConfigForTests();
});

afterEach(() => {
  if (originalRoutes === undefined) delete process.env.DECISION_ROUTES;
  else process.env.DECISION_ROUTES = originalRoutes;
  if (originalEnabled === undefined) delete process.env.DECISION_MODELS_ENABLED;
  else process.env.DECISION_MODELS_ENABLED = originalEnabled;
  if (originalJevKey === undefined) delete process.env.JEV_API_KEY;
  else process.env.JEV_API_KEY = originalJevKey;
  resetDecisionConfigForTests();
});

describe('decision config', () => {
  it('parses a typed decision server with conservative defaults', () => {
    const routes = parseDecisionRoutes(
      JSON.stringify({
        'quiz-verify': {
          provider: 'laya',
          endpoint: 'http://127.0.0.1:8090/',
          mode: 'replace',
        },
      }),
      env(),
    );

    expect(routes.get('quiz-verify')).toMatchObject({
      site: 'quiz-verify',
      provider: 'laya',
      mode: 'replace',
      endpoint: 'http://127.0.0.1:8090',
      timeoutMs: 4_000,
      minConfidence: 0.9,
      maxInputChars: 12_000,
      fallback: 'llm',
    });
  });

  it('supports a chat model for any configured provider', () => {
    const routes = parseDecisionRoutes(
      JSON.stringify({
        'quiz-grade': {
          provider: 'chat',
          model: 'ollama:qwen3:4b',
          mode: 'triage',
          minConfidence: 0.8,
          timeoutMs: 2_500,
          maxInputChars: 6_000,
        },
      }),
      env(),
    );

    expect(routes.get('quiz-grade')).toMatchObject({
      provider: 'chat',
      model: 'ollama:qwen3:4b',
      mode: 'triage',
      minConfidence: 0.8,
      timeoutMs: 2_500,
      maxInputChars: 6_000,
    });
  });

  it('enables decoder-level JSON mode for a chat site', () => {
    const routes = parseDecisionRoutes(
      JSON.stringify({
        'quiz-grade': {
          provider: 'chat',
          model: 'ollama:qwen3:4b',
          jsonMode: true,
        },
      }),
      env(),
    );

    expect(routes.get('quiz-grade')).toMatchObject({ jsonMode: true });
  });

  it('keeps jsonMode out of typed sites instead of failing the site', () => {
    const routes = parseDecisionRoutes(
      JSON.stringify({
        'quiz-verify': {
          provider: 'laya',
          endpoint: 'http://127.0.0.1:8090',
          jsonMode: true,
        },
      }),
      env(),
    );

    const site = routes.get('quiz-verify');
    expect(site?.provider).toBe('laya');
    expect(site?.jsonMode).toBeUndefined();
  });

  it('ignores a non-boolean jsonMode', () => {
    const routes = parseDecisionRoutes(
      JSON.stringify({
        'quiz-grade': {
          provider: 'chat',
          model: 'ollama:qwen3:4b',
          jsonMode: 'yes',
        },
      }),
      env(),
    );

    expect(routes.get('quiz-grade')?.jsonMode).toBeUndefined();
  });

  it('defaults chat to replace and a cold-start timeout', () => {
    const routes = parseDecisionRoutes(
      JSON.stringify({
        'quiz-grade': {
          provider: 'chat',
          model: 'ollama:qwen3:4b',
        },
      }),
      env(),
    );

    expect(routes.get('quiz-grade')).toMatchObject({
      provider: 'chat',
      mode: 'replace',
      timeoutMs: 15_000,
    });
  });

  it('resolves an API key from a named env var', () => {
    const routes = parseDecisionRoutes(
      JSON.stringify({
        'exam-grading': {
          provider: 'jev',
          endpoint: 'https://api.example.test',
          apiKeyEnv: 'JEV_API_KEY',
        },
      }),
      env({ JEV_API_KEY: 'secret' }),
    );

    expect(routes.get('exam-grading')).toMatchObject({
      provider: 'jev',
      apiKey: 'secret',
      // Omitted mode defaults to the safe validation mode, not replace.
      mode: 'triage',
    });
  });

  it('drops entries that cannot run', () => {
    const routes = parseDecisionRoutes(
      JSON.stringify({
        'quiz-verify': { provider: 'laya', endpoint: 'ftp://nope' },
        'exam-grading': { provider: 'chat' },
        'quiz-grade': { provider: 'laya', endpoint: 'http://localhost:1', mode: 'bogus' },
        'not-a-site': { provider: 'laya', endpoint: 'http://localhost:1' },
        'quiz-verify2': { provider: 'nope', endpoint: 'http://localhost:1' },
      }),
      env(),
    );

    expect(routes.size).toBe(0);
  });

  it('treats mode off as an absent site without constructing a provider', () => {
    const routes = parseDecisionRoutes(
      JSON.stringify({
        'quiz-verify': { provider: 'laya', endpoint: 'http://localhost:8090', mode: 'off' },
      }),
      env(),
    );
    expect(routes.has('quiz-verify')).toBe(false);
  });

  it('honors the global kill switch', () => {
    expect(decisionModelsEnabled(env({ DECISION_MODELS_ENABLED: 'false' }))).toBe(false);
    expect(decisionModelsEnabled(env({ DECISION_MODELS_ENABLED: '0' }))).toBe(false);
    expect(decisionModelsEnabled(env({ DECISION_MODELS_ENABLED: 'off' }))).toBe(false);
    expect(decisionModelsEnabled(env({ DECISION_MODELS_ENABLED: 'true' }))).toBe(true);

    const routes = parseDecisionRoutes(
      JSON.stringify({
        'quiz-verify': { provider: 'laya', endpoint: 'http://localhost:8090' },
      }),
      env({ DECISION_MODELS_ENABLED: 'false' }),
    );
    expect(routes.size).toBe(0);
  });

  it('ignores malformed JSON instead of throwing', () => {
    expect(parseDecisionRoutes('{not json', env()).size).toBe(0);
  });

  it('caches until reset', () => {
    process.env.DECISION_ROUTES = JSON.stringify({
      'quiz-verify': { provider: 'laya', endpoint: 'http://localhost:8090', mode: 'replace' },
    });
    expect(getDecisionSiteConfig('quiz-verify')?.mode).toBe('replace');

    process.env.DECISION_ROUTES = JSON.stringify({
      'quiz-verify': { provider: 'laya', endpoint: 'http://localhost:8090', mode: 'shadow' },
    });
    expect(getDecisionSiteConfig('quiz-verify')?.mode).toBe('replace');

    resetDecisionConfigForTests();
    expect(getDecisionSiteConfig('quiz-verify')?.mode).toBe('shadow');
  });
});
