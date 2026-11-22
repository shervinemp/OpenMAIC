import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { GET } from '@/app/api/decision/status/route';
import { resetDecisionTelemetryForTests } from '@/lib/decision/telemetry';

const originalToken = process.env.PERSISTENCE_DEV_TOKEN;

function request(token?: string): NextRequest {
  return new NextRequest('http://localhost/api/decision/status', {
    method: 'GET',
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
}

beforeEach(() => {
  process.env.PERSISTENCE_DEV_TOKEN = 'probe-token';
  resetDecisionTelemetryForTests();
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.PERSISTENCE_DEV_TOKEN;
  else process.env.PERSISTENCE_DEV_TOKEN = originalToken;
  resetDecisionTelemetryForTests();
});

describe('/api/decision/status', () => {
  it('refuses every request without the dev persistence token', async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ success: false, errorCode: 'UNAUTHENTICATED' });
  });

  it('reports the settings-driven source and telemetry only', async () => {
    const res = await GET(request('probe-token'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      sites: unknown[];
      telemetry: { counters: unknown[]; shadow: unknown[] };
    };
    expect(body.source).toBe('settings');
    expect(body.sites).toEqual(['quiz-verify', 'exam-grading', 'quiz-grade', 'claim-check']);
    expect(body.telemetry).toEqual({ counters: [], shadow: [] });
  });
});
