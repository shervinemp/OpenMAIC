import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/activity/server/docker', () => ({
  runServerActivity: vi.fn(),
}));

import { runServerActivity } from '@/lib/activity/server/docker';
import { POST } from '@/app/api/activity/run/route';

const ENV_KEYS = ['ACTIVITY_SERVER_RUNTIME_ENABLED', 'ACTIVITY_DOCKER_IMAGE'] as const;
const saved = new Map<string, string | undefined>();

const REQUEST = {
  kind: 'terminal',
  runtime: 'server',
  timeLimitMs: 10_000,
  initialFiles: { 'notes.txt': 'hello\n' },
  commands: ['cat notes.txt'],
};

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/activity/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  vi.mocked(runServerActivity).mockReset();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST /api/activity/run', () => {
  it('is disabled unless the operator enables both the tier and an image', async () => {
    const response = await POST(post(REQUEST));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.errorCode).toBe('ACTIVITY_RUNTIME_DISABLED');
    expect(runServerActivity).not.toHaveBeenCalled();
  });

  it('validates the request before starting a container', async () => {
    process.env.ACTIVITY_SERVER_RUNTIME_ENABLED = 'true';
    process.env.ACTIVITY_DOCKER_IMAGE = 'sandbox:test';

    const response = await POST(post({ ...REQUEST, commands: 'pwd' }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.errorCode).toBe('ACTIVITY_REQUEST_INVALID');
    expect(runServerActivity).not.toHaveBeenCalled();
  });

  it('returns a sandbox result', async () => {
    process.env.ACTIVITY_SERVER_RUNTIME_ENABLED = 'true';
    process.env.ACTIVITY_DOCKER_IMAGE = 'sandbox:test';
    vi.mocked(runServerActivity).mockResolvedValue({
      result: {
        status: 'ok',
        stdout: 'hello\n',
        stderr: '',
        files: { 'notes.txt': 'hello\n' },
        state: { cwd: '/home/learner' },
        durationMs: 12,
      },
    });

    const response = await POST(post(REQUEST));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, result: { status: 'ok', stdout: 'hello\n' } });
    expect(vi.mocked(runServerActivity).mock.calls[0]?.[0]).toEqual(REQUEST);
  });

  it('maps capacity to 429', async () => {
    process.env.ACTIVITY_SERVER_RUNTIME_ENABLED = 'true';
    process.env.ACTIVITY_DOCKER_IMAGE = 'sandbox:test';
    vi.mocked(runServerActivity).mockResolvedValue({ busy: true });

    const response = await POST(post(REQUEST));
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.errorCode).toBe('ACTIVITY_RUNTIME_BUSY');
  });
});
