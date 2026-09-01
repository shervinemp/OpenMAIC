import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the generation readiness pre-flight route.
 *
 * The contract that matters: resolution parity with the real generate
 * routes (server config > client value > registry default) and a
 * server-decided `blocking` flag the client never re-interprets.
 */

const post = async (body: unknown) => {
  const { POST } = await import('@/app/api/generation-readiness/route');
  return POST(
    new Request('http://localhost:3000/api/generation-readiness', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
  );
};

const json = async (res: Response) => {
  expect(res.status).toBe(200);
  return (await res.json()) as {
    checks: Array<{ key: string; status: string; blocking: boolean; detail?: string }>;
  };
};

/** fetch behavior for a probe target: an HTTP response, or a transport failure. */
type ProbeBehavior = { status: number } | { transportError: true };

const stubFetch = (behavior: ProbeBehavior) => {
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: string | URL) => {
      if ('transportError' in behavior) {
        // What undici throws when nothing is listening on the port.
        return Promise.reject(new TypeError('fetch failed: ECONNREFUSED'));
      }
      return Promise.resolve(new Response(null, { status: behavior.status }));
    }),
  );
};

describe('generation readiness route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reports a dead local TTS server as blocking and a live one as ready', async () => {
    stubFetch({ transportError: true });
    const dead = await json(
      await post({ tts: { enabled: true, providerId: 'custom-tts-kokoro', baseUrl: 'http://localhost:8080' } }),
    );
    expect(dead.checks).toEqual([
      {
        key: 'tts',
        status: 'unreachable',
        blocking: true,
        detail: expect.stringContaining('http://localhost:8080'),
      },
    ]);

    stubFetch({ status: 200 });
    const alive = await json(
      await post({ tts: { enabled: true, providerId: 'custom-tts-kokoro', baseUrl: 'http://localhost:8080' } }),
    );
    expect(alive.checks).toEqual([
      { key: 'tts', status: 'ready', blocking: false, detail: expect.any(String) },
    ]);
  });

  it('applies the ComfyUI registry default and flags a missing workflow selection as blocking', async () => {
    stubFetch({ status: 200 });
    const noModel = await json(
      await post({
        image: { enabled: true, providerId: 'comfyui-image', baseUrl: '', modelSelected: false },
      }),
    );
    expect(noModel.checks).toEqual([
      { key: 'image', status: 'unconfigured', blocking: true, detail: expect.any(String) },
    ]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    const withModel = await json(
      await post({
        image: { enabled: true, providerId: 'comfyui-image', baseUrl: '', modelSelected: true },
      }),
    );
    expect(withModel.checks).toEqual([
      { key: 'image', status: 'ready', blocking: false, detail: expect.any(String) },
    ]);
    // Resolution parity with the comfy adapter: default base URL + system_stats.
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://localhost:8188/system_stats',
      expect.anything(),
    );
  });

  it('skips disabled modalities and treats browser-native TTS as ready without probing', async () => {
    stubFetch({ transportError: true });
    const data = await json(
      await post({
        image: { enabled: false, providerId: 'comfyui-image', baseUrl: 'http://localhost:8188' },
        video: { enabled: false, providerId: 'comfyui-video', baseUrl: 'http://localhost:8188' },
        tts: { enabled: true, providerId: 'browser-native-tts', baseUrl: '' },
      }),
    );
    expect(data.checks).toEqual([
      { key: 'tts', status: 'ready', blocking: false, detail: 'browser-native-tts' },
    ]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('marks an LLM with neither server key nor base URL as blocking', async () => {
    stubFetch({ status: 200 });
    const data = await json(
      await post({ llm: { providerId: 'unknown-provider', modelId: 'm-1', apiKey: '', baseUrl: '' } }),
    );
    expect(data.checks).toEqual([
      { key: 'llm', status: 'unconfigured', blocking: true, detail: expect.any(String) },
    ]);
  });

  it('probes the LLM base URL with the caller key and reports reachability', async () => {
    stubFetch({ status: 200 });
    const data = await json(
      await post({
        llm: {
          providerId: 'unknown-provider',
          modelId: 'm-1',
          apiKey: 'sk-test',
          baseUrl: 'https://gateway.example/v1',
        },
      }),
    );
    expect(data.checks).toEqual([
      { key: 'llm', status: 'ready', blocking: false, detail: expect.any(String) },
    ]);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'https://gateway.example/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
      }),
    );
  });

  it('rejects malformed JSON with 400', async () => {
    const { POST } = await import('@/app/api/generation-readiness/route');
    const res = await POST(
      new Request('http://localhost:3000/api/generation-readiness', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }) as never,
    );
    expect(res.status).toBe(400);
  });
});
