import { describe, expect, it } from 'vitest';

import {
  activeGenerationCallCount,
  activeGenerationCallCountFor,
  anyAbortSignal,
  cancelGeneration,
  generationSessionIdFrom,
  registerGenerationCall,
} from '@/lib/server/generation-cancel';

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

describe('browser generation cancellation', () => {
  it('aborts every in-flight call for the named session only', async () => {
    const callA1 = registerGenerationCall('session-a', '/api/documents/index');
    const callA2 = registerGenerationCall('session-a', '/api/web-search');
    const callB = registerGenerationCall('session-b', '/api/documents/index');

    expect(activeGenerationCallCount()).toBe(3);
    expect(cancelGeneration('session-a')).toBe(2);
    await Promise.all([waitForAbort(callA1.signal), waitForAbort(callA2.signal)]);
    expect(callB.signal.aborted).toBe(false);

    expect(cancelGeneration('session-a')).toBe(0);
    expect(cancelGeneration('session-b')).toBe(1);
    expect(callB.signal.aborted).toBe(true);

    callA1.dispose();
    callA2.dispose();
    callB.dispose();
    expect(activeGenerationCallCount()).toBe(0);
  });

  it('reports remaining calls per session so cancellation can be confirmed', () => {
    const first = registerGenerationCall('session-d', '/api/generate/scene-content');
    const second = registerGenerationCall('session-d', '/api/generate/scene-actions');
    expect(activeGenerationCallCountFor('session-d')).toBe(2);
    expect(activeGenerationCallCountFor('missing')).toBe(0);

    expect(cancelGeneration('session-d')).toBe(2);
    expect(activeGenerationCallCountFor('session-d')).toBe(0);
    first.dispose();
    second.dispose();
    expect(activeGenerationCallCountFor('session-d')).toBe(0);
  });

  it('aborts a request that registers after its session was cancelled', async () => {
    expect(cancelGeneration('session-late')).toBe(0);
    const late = registerGenerationCall('session-late', '/api/generate/scene-content');
    expect(late.signal.aborted).toBe(true);
    expect(activeGenerationCallCountFor('session-late')).toBe(0);
    late.dispose();
  });

  it('combines the client disconnect signal with the session cancel signal', async () => {
    const client = new AbortController();
    const session = registerGenerationCall('session-c', '/api/generate/scene-outlines-stream');
    const combined = anyAbortSignal(client.signal, session.signal);

    client.abort();
    expect(combined.aborted).toBe(true);
    session.dispose();
  });

  it('reads the session id only from the request header', () => {
    expect(generationSessionIdFrom(new Request('http://localhost/x'))).toBeUndefined();
    expect(
      generationSessionIdFrom(
        new Request('http://localhost/x', { headers: { 'x-generation-session': 'sid-1' } }),
      ),
    ).toBe('sid-1');
  });
});
