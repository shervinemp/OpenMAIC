import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerTerminalRunner } from '@/lib/activity/server-runner';
import type { ActivityRunRequest } from '@/lib/activity/protocol';

const REQUEST: ActivityRunRequest = {
  kind: 'terminal',
  runtime: 'server',
  timeLimitMs: 10_000,
  initialFiles: { 'notes.txt': 'hello\n' },
  commands: ['cat notes.txt'],
};

const RESULT = {
  status: 'ok' as const,
  stdout: 'hello\n',
  stderr: '',
  files: { 'notes.txt': 'hello\n' },
  state: { cwd: '/home/learner' },
  durationMs: 12,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ServerTerminalRunner', () => {
  it('forwards the request and returns the sandbox result', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: RESULT }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const runner = createServerTerminalRunner();
    await expect(runner.run(REQUEST)).resolves.toEqual(RESULT);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/activity/run',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(REQUEST) }),
    );
  });

  it('turns a disabled runtime into an ungraded harness error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({
          success: false,
          errorCode: 'ACTIVITY_RUNTIME_DISABLED',
          error: 'The server activity runtime is not enabled on this deployment.',
        }),
      })),
    );

    const runner = createServerTerminalRunner();
    await expect(runner.run(REQUEST)).resolves.toMatchObject({
      status: 'error',
      error: 'The server activity runtime is not enabled on this deployment.',
    });
  });

  it('never fabricates a result for a malformed response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      })),
    );
    const runner = createServerTerminalRunner();
    await expect(runner.run(REQUEST)).resolves.toMatchObject({
      status: 'error',
      error: 'The server runtime returned no usable result.',
    });
  });

  it('refuses simulation requests and reports disposal', async () => {
    const runner = createServerTerminalRunner();
    await expect(runner.run({ ...REQUEST, runtime: 'simulation' })).resolves.toMatchObject({
      status: 'error',
    });
    runner.dispose();
    await expect(runner.run(REQUEST)).resolves.toMatchObject({
      status: 'error',
      error: 'The server runner was disposed.',
    });
  });
});
