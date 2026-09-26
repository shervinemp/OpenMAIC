import { describe, expect, it, vi } from 'vitest';

import { isProducingSessionActive } from '@/lib/classroom/producing-session';

const respond = (status: number, body?: unknown) =>
  vi.fn(async () =>
    body === undefined
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;

describe('isProducingSessionActive', () => {
  it('is active while the producing session is queued or running', async () => {
    expect(await isProducingSessionActive('s1', respond(200, { s1: 'running' }))).toBe(true);
    expect(await isProducingSessionActive('s1', respond(200, { s1: 'queued' }))).toBe(true);
  });

  it('is settled once the producing session finished, however it ended', async () => {
    for (const status of ['succeeded', 'failed', 'cancelled']) {
      expect(await isProducingSessionActive('s1', respond(200, { s1: status }))).toBe(false);
    }
  });

  it('ignores other sessions when it knows which one produces the course', async () => {
    expect(
      await isProducingSessionActive('s1', respond(200, { s1: 'succeeded', s2: 'running' })),
    ).toBe(false);
  });

  it('treats any live session as possibly producing when there is no handle', async () => {
    expect(await isProducingSessionActive(null, respond(200, { s2: 'running' }))).toBe(true);
    expect(await isProducingSessionActive(null, respond(200, { s2: 'succeeded' }))).toBe(false);
  });

  it('has nothing producing on a deployment without the agent runtime', async () => {
    expect(await isProducingSessionActive('s1', respond(404))).toBe(false);
  });

  it('fails closed when it cannot tell', async () => {
    expect(await isProducingSessionActive('s1', respond(500))).toBe(true);
    const offline = vi.fn(async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    expect(await isProducingSessionActive('s1', offline)).toBe(true);
  });
});
