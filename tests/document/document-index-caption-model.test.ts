import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Captions are perception, not planning: a cheap vision model can do them
 * while the coverage digest stays on the main model. These tests drive the
 * real index route with both models resolved, and assert which model receives
 * the caption call - including the fallbacks that keep a misconfigured route
 * from silently dropping captions.
 */

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  resolveModelFromRequest: vi.fn(),
  resolveModel: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
  resolveModel: mocks.resolveModel,
}));

const MAIN_MODEL = { provider: 'openai', modelId: 'gpt-main' } as never;
const CAPTION_MODEL = { provider: 'openai', modelId: 'gpt-vision-cheap' } as never;

function binding(options: {
  model: unknown;
  modelString: string;
  vision: boolean;
  serverManaged?: boolean;
}) {
  return {
    model: options.model,
    modelInfo: { outputWindow: 4096, capabilities: { vision: options.vision } },
    modelString: options.modelString,
    thinkingConfig: undefined,
    serverManaged: options.serverManaged ?? true,
  };
}

async function readStreamBody(response: Response) {
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const decoder = new TextDecoder();
  let text = '';
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

function parseSseEvents(text: string) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

function uniqueText(label: string) {
  return `${label}: photosynthesis converts light into chemical energy. `.repeat(20);
}

async function indexDocument(label: string, modelRoutesHeader?: string) {
  const { POST } = await import('@/app/api/documents/index/route');
  const response = await POST({
    json: async () => ({
      text: uniqueText(label),
      language: 'English',
      images: [
        {
          id: 'img_1',
          src: 'data:image/png;base64,AAAA',
          pageNumber: 1,
          width: 640,
          height: 480,
        },
      ],
    }),
    headers: {
      get: (name: string) => (name === 'x-model-routes' ? (modelRoutesHeader ?? null) : null),
    },
  } as never);
  const events = parseSseEvents(await readStreamBody(response));
  return { response, events };
}

describe('document index caption model', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('PERSISTENCE_DIR', '');
    mocks.callLLM.mockReset();
    mocks.resolveModel.mockReset();
    mocks.resolveModelFromRequest.mockReset();
    mocks.resolveModelFromRequest.mockResolvedValue(
      binding({ model: MAIN_MODEL, modelString: 'openai:gpt-main', vision: true }),
    );
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify({
        images: [{ id: 'img_1', caption: 'A chart of photosynthesis rates.', kind: 'chart' }],
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('captions with the index model when no caption route is configured', async () => {
    const { events } = await indexDocument('default-caption');

    expect(events.find((event) => event.type === 'done')).toBeDefined();
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(mocks.callLLM.mock.calls[0]![0]).toMatchObject({ model: MAIN_MODEL });
  });

  it('routes caption calls to a separate cheap vision model', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'documents-captions': 'openai:gpt-vision-cheap' }));
    mocks.resolveModel.mockResolvedValue(
      binding({ model: CAPTION_MODEL, modelString: 'openai:gpt-vision-cheap', vision: true }),
    );

    const { events } = await indexDocument('separate-caption');

    const done = events.find((event) => event.type === 'done');
    expect(done?.data.captions.img_1.caption).toBe('A chart of photosynthesis rates.');
    expect(mocks.resolveModel).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'documents-captions',
        modelString: 'openai:gpt-main',
      }),
    );
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(mocks.callLLM.mock.calls[0]![0]).toMatchObject({ model: CAPTION_MODEL });
    expect(mocks.callLLM.mock.calls[0]![1]).toBe('documents-captions');
  });

  it('honors a user-level documents-captions route', async () => {
    mocks.resolveModel.mockResolvedValue(
      binding({ model: CAPTION_MODEL, modelString: 'openai:gpt-vision-cheap', vision: true }),
    );

    const { events } = await indexDocument(
      'user-caption-route',
      JSON.stringify({ 'documents-captions': { model: 'openai:gpt-vision-cheap' } }),
    );

    expect(events.find((event) => event.type === 'done')).toBeDefined();
    expect(mocks.resolveModel).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'documents-captions',
        userRoutes: expect.objectContaining({
          'documents-captions': expect.objectContaining({ model: 'openai:gpt-vision-cheap' }),
        }),
      }),
    );
    expect(mocks.callLLM.mock.calls[0]![0]).toMatchObject({ model: CAPTION_MODEL });
  });

  it('falls back to the index model when the caption route has no vision', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'documents-captions': 'openai:gpt-text' }));
    mocks.resolveModel.mockResolvedValue(
      binding({ model: CAPTION_MODEL, modelString: 'openai:gpt-text', vision: false }),
    );

    const { events } = await indexDocument('caption-model-no-vision');

    expect(events.find((event) => event.type === 'done')).toBeDefined();
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(mocks.callLLM.mock.calls[0]![0]).toMatchObject({ model: MAIN_MODEL });
    expect(mocks.callLLM.mock.calls[0]![1]).toBe('documents-index');
  });

  it('captions with the routed model even when the index model has no vision', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'documents-captions': 'openai:gpt-vision-cheap' }));
    mocks.resolveModelFromRequest.mockResolvedValue(
      binding({ model: MAIN_MODEL, modelString: 'openai:gpt-main', vision: false }),
    );
    mocks.resolveModel.mockResolvedValue(
      binding({ model: CAPTION_MODEL, modelString: 'openai:gpt-vision-cheap', vision: true }),
    );

    const { events } = await indexDocument('caption-only-vision');

    const done = events.find((event) => event.type === 'done');
    expect(done?.data.captions.img_1.caption).toBe('A chart of photosynthesis rates.');
    expect(mocks.callLLM.mock.calls[0]![0]).toMatchObject({ model: CAPTION_MODEL });
  });

  it('falls back to the index model when the caption route cannot resolve', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'documents-captions': 'missing:model' }));
    mocks.resolveModel.mockRejectedValue(new Error('no credentials'));

    const { events } = await indexDocument('caption-route-unresolvable');

    expect(events.find((event) => event.type === 'done')).toBeDefined();
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(mocks.callLLM.mock.calls[0]![0]).toMatchObject({ model: MAIN_MODEL });
  });
});
