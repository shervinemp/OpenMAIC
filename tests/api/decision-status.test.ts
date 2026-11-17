import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { GET, POST } from '@/app/api/decision/status/route';
import { resetDecisionConfigForTests } from '@/lib/decision/config';
import { resetDecisionTelemetryForTests } from '@/lib/decision/telemetry';

const originalRoutes = process.env.DECISION_ROUTES;
const originalToken = process.env.PERSISTENCE_DEV_TOKEN;

function request(method: 'GET' | 'POST', token?: string): NextRequest {
  return new NextRequest('http://localhost/api/decision/status', {
    method,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
}

beforeEach(() => {
  process.env.PERSISTENCE_DEV_TOKEN = 'probe-token';
  process.env.DECISION_ROUTES = JSON.stringify({
    'quiz-grade': {
      provider: 'chat',
      model: 'ollama:qwen3:4b',
      mode: 'replace',
    },
  });
  resetDecisionConfigForTests();
  resetDecisionTelemetryForTests();
});

afterEach(() => {
  if (originalRoutes === undefined) delete process.env.DECISION_ROUTES;
  else process.env.DECISION_ROUTES = originalRoutes;
  if (originalToken === undefined) delete process.env.PERSISTENCE_DEV_TOKEN;
  else process.env.PERSISTENCE_DEV_TOKEN = originalToken;
  resetDecisionConfigForTests();
  resetDecisionTelemetryForTests();
});

describe('/api/decision/status', () => {
  it('refuses every request without the dev persistence token', async () => {
    const res = await GET(request('GET'));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ success: false, errorCode: 'UNAUTHENTICATED' });
  });

  it('reports configured sites and telemetry without leaking the API key', async () => {
    process.env.DECISION_ROUTES = JSON.stringify({
      'quiz-grade': {
        provider: 'chat',
        model: 'ollama:qwen3:4b',
        mode: 'replace',
        apiKey: 'should-not-leak',
      },
    });
    resetDecisionConfigForTests();

    const res = await GET(request('GET', 'probe-token'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      sites: Array<Record<string, unknown>>;
      telemetry: { counters: unknown[]; shadow: unknown[] };
    };

    expect(body.enabled).toBe(true);
    expect(body.sites[0]).toMatchObject({
      site: 'quiz-grade',
      provider: 'chat',
      mode: 'replace',
      model: 'ollama:qwen3:4b',
    });
    expect(body.sites[0]).not.toHaveProperty('apiKey');
    expect(body.telemetry).toEqual({ counters: [], shadow: [] });
    // Chat config drops the key at parse time anyway; the route must not
    // resurrect it by spreading the raw entry.
    expect(JSON.stringify(body)).not.toContain('should-not-leak');
  });

  it('probes configured sites without spending a chat model call', async () => {
    const res = await POST(request('POST', 'probe-token'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      probes: Array<{ site: string; status: string; detail?: string }>;
    };

    expect(body.probes).toEqual([
      expect.objectContaining({
        site: 'quiz-grade',
        status: 'configured',
      }),
    ]);
  });
});
