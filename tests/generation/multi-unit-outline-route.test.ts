import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const streamLLMMock = vi.hoisted(() => vi.fn());
const callLLMMock = vi.hoisted(() => vi.fn());
const resolveModelFromRequestMock = vi.hoisted(() => vi.fn());
const searchWebMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/llm', () => ({
  streamLLM: streamLLMMock,
  callLLM: callLLMMock,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: resolveModelFromRequestMock,
}));

vi.mock('@/lib/web-search', async () => {
  const actual = await vi.importActual<typeof import('@/lib/web-search')>('@/lib/web-search');
  return {
    ...actual,
    searchWeb: searchWebMock,
  };
});

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

function mockRequest(body: Record<string, unknown>) {
  return {
    json: async () => body,
    headers: {
      get: () => null,
    },
  };
}

/**
 * Standard preset, no explicit duration → 60 min → 60 scenes, 6 lessons
 * (10 scenes each) → 2 units of 3 lessons.
 */
const REQUIREMENTS = {
  requirement: 'Teach me a complete university course on operating systems in English',
  webSearch: false,
};

const TOTAL_SCENES = 60;
const SCENES_PER_UNIT = 30;

function sceneOutline(id: string, order: number, type: string = 'slide') {
  return {
    id,
    type,
    title: `Scene ${order}: ${id}`,
    description: `Describe scene ${order} with a concrete worked example.`,
    keyPoints: [`Key A ${order}`, `Key B ${order}`],
    order,
  };
}

function syllabusResponse() {
  return {
    languageDirective: 'Teach in English.',
    courseTitle: 'Operating Systems',
    audience: 'CS undergraduates',
    objectives: ['Understand process management', 'Understand memory management'],
    units: [
      {
        title: 'Processes and Threads',
        objectives: ['Model process lifecycles'],
        lessons: [
          { title: 'Process abstraction', objectives: ['Define a process'] },
          { title: 'Threads', objectives: ['Compare threads and processes'] },
          { title: 'Scheduling', objectives: ['Evaluate scheduling policies'] },
        ],
      },
      {
        title: 'Memory Management',
        objectives: ['Model virtual memory'],
        lessons: [
          { title: 'Address spaces', objectives: ['Explain address translation'] },
          { title: 'Paging', objectives: ['Analyze page tables'] },
          { title: 'Page replacement', objectives: ['Compare replacement policies'] },
        ],
      },
    ],
  };
}

/** Each unit call returns its 3×10 outlines (30 scenes). */
function unitOutlines(unitIndex: number) {
  const outlines = [];
  for (let order = 1; order <= SCENES_PER_UNIT; order++) {
    outlines.push(sceneOutline(`u${unitIndex}_s${order}`, order));
  }
  return { outlines };
}

/** The unit review gate's accept verdict (Phase 2 §15.5). */
function unitReviewPass() {
  return { adequate: true, findings: [] };
}

describe('multi-unit outline route (Phase 2 §15.8)', () => {
  beforeEach(() => {
    resolveModelFromRequestMock.mockReset();
    streamLLMMock.mockReset();
    callLLMMock.mockReset();
    searchWebMock.mockReset();
    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'openai', modelId: 'gpt-test' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'openai:gpt-test',
      providerId: 'openai',
      modelId: 'gpt-test',
      thinkingConfig: undefined,
    });
    // Single-call path must not be exercised by these tests.
    streamLLMMock.mockImplementation(() => {
      throw new Error('single-call streamLLM should not run in multi-unit mode');
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  test('standard preset: syllabus call + per-unit calls assemble a valid blueprint', async () => {
    callLLMMock
      .mockResolvedValueOnce({ text: JSON.stringify(syllabusResponse()), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitOutlines(0)), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitReviewPass()), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitOutlines(1)), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitReviewPass()), usage: {} });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirements: REQUIREMENTS,
        sizePreset: 'standard',
        pdfText: '',
        pdfImages: [],
        imageMapping: {},
        researchContext: '',
      }) as unknown as Parameters<typeof POST>[0],
    );

    expect(response.status).toBe(200);
    const text = await readStreamBody(response);
    const events = parseSseEvents(text);

    const syllabusEvent = events.find((e) => e.type === 'syllabus');
    expect(syllabusEvent).toBeDefined();
    expect(syllabusEvent.units).toHaveLength(2);
    expect(syllabusEvent.lessons).toHaveLength(6);

    const unitEvents = events.filter((e) => e.type === 'unit');
    expect(unitEvents.map((e) => e.title)).toEqual(['Processes and Threads', 'Memory Management']);

    // Phase 2 §15.5: one review event per unit, both accepted.
    const reviewEvents = events.filter((e) => e.type === 'unitReview');
    expect(reviewEvents).toHaveLength(2);
    expect(reviewEvents.map((e) => e.adequate)).toEqual([true, true]);

    const outlineEvents = events.filter((e) => e.type === 'outline');
    expect(outlineEvents).toHaveLength(TOTAL_SCENES);
    // Global numbering across units, no duplicates.
    const orders = outlineEvents.map((e) => e.data.order);
    expect(orders[0]).toBe(1);
    expect(orders[SCENES_PER_UNIT - 1]).toBe(SCENES_PER_UNIT);
    expect(orders[SCENES_PER_UNIT]).toBe(SCENES_PER_UNIT + 1);
    expect(orders[TOTAL_SCENES - 1]).toBe(TOTAL_SCENES);
    expect(new Set(orders).size).toBe(TOTAL_SCENES);

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done.blueprint).toBeDefined();
    expect(done.blueprint.units).toHaveLength(2);
    expect(done.blueprint.units[0].lessons).toHaveLength(3);
    expect(done.outlines).toHaveLength(TOTAL_SCENES);
    expect(done.blueprint.sizePreset).toBe('standard');
  });

  test('syllabus corrective loop fixes the structure on retry', async () => {
    const wrongSyllabus = {
      ...syllabusResponse(),
      units: [
        { title: 'Only unit', objectives: ['x'], lessons: [{ title: 'L1', objectives: ['o'] }] },
      ],
    };
    callLLMMock
      .mockResolvedValueOnce({ text: JSON.stringify(wrongSyllabus), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(syllabusResponse()), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitOutlines(0)), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitReviewPass()), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitOutlines(1)), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitReviewPass()), usage: {} });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirements: REQUIREMENTS,
        sizePreset: 'standard',
        pdfText: '',
        pdfImages: [],
        imageMapping: {},
        researchContext: '',
      }) as unknown as Parameters<typeof POST>[0],
    );

    const text = await readStreamBody(response);
    const events = parseSseEvents(text);
    expect(events.find((e) => e.type === 'done')).toBeDefined();
    // Syllabus retry + 2 unit calls + 2 unit reviews.
    expect(callLLMMock).toHaveBeenCalledTimes(6);
  });

  test('per-unit corrective loop re-calls a unit that missed its counts', async () => {
    const shortUnit = { outlines: unitOutlines(0).outlines.slice(0, 10) };
    callLLMMock
      .mockResolvedValueOnce({ text: JSON.stringify(syllabusResponse()), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(shortUnit), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitOutlines(0)), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitReviewPass()), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitOutlines(1)), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitReviewPass()), usage: {} });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirements: REQUIREMENTS,
        sizePreset: 'standard',
        pdfText: '',
        pdfImages: [],
        imageMapping: {},
        researchContext: '',
      }) as unknown as Parameters<typeof POST>[0],
    );

    const text = await readStreamBody(response);
    const events = parseSseEvents(text);
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done.outlines).toHaveLength(TOTAL_SCENES);
    // Syllabus + unit0 retry + unit0 + review0 + unit1 + review1.
    expect(callLLMMock).toHaveBeenCalledTimes(6);
  });

  test('per-unit web research grounds unit outlines with [source N] citations (Phase 2 §15.2)', async () => {
    searchWebMock.mockImplementation(async (params: { query: string }) => ({
      answer: 'summary',
      query: params.query,
      responseTime: 1,
      sources: [
        {
          title: 'Result A',
          url: 'https://example.com/a',
          content:
            'A process is a running program instance with its own address space. The scheduler assigns CPU time to ready processes.',
          score: 0.9,
        },
      ],
    }));
    callLLMMock
      .mockResolvedValueOnce({ text: JSON.stringify(syllabusResponse()), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitOutlines(0)), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitReviewPass()), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitOutlines(1)), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitReviewPass()), usage: {} });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirements: REQUIREMENTS,
        sizePreset: 'standard',
        pdfText: '',
        pdfImages: [],
        imageMapping: {},
        researchContext: '',
        webSearchConfig: { providerId: 'tavily', apiKey: 'k' },
      }) as unknown as Parameters<typeof POST>[0],
    );

    const text = await readStreamBody(response);
    const events = parseSseEvents(text);
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();

    // One search per unit, queried from the unit title + objectives.
    expect(searchWebMock).toHaveBeenCalledTimes(2);
    expect(searchWebMock.mock.calls[0][0].query).toContain('Processes and Threads');
    expect(searchWebMock.mock.calls[1][0].query).toContain('Memory Management');

    // Unit 0 outlines carry retrieval context with web citations.
    const firstOutline = done.outlines[0];
    expect(firstOutline.retrievalContext).toBeDefined();
    expect(firstOutline.retrievalContext).toContain('[source 1]');
  });

  test('per-unit web research failure falls back to the global context without failing the run', async () => {
    searchWebMock.mockRejectedValue(new Error('search down'));
    callLLMMock
      .mockResolvedValueOnce({ text: JSON.stringify(syllabusResponse()), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitOutlines(0)), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitReviewPass()), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitOutlines(1)), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitReviewPass()), usage: {} });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirements: REQUIREMENTS,
        sizePreset: 'standard',
        pdfText: '',
        pdfImages: [],
        imageMapping: {},
        researchContext: 'Global research fallback text',
        webSearchConfig: { providerId: 'tavily', apiKey: 'k' },
      }) as unknown as Parameters<typeof POST>[0],
    );

    const text = await readStreamBody(response);
    const events = parseSseEvents(text);
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done.outlines).toHaveLength(TOTAL_SCENES);
  });

  test('unit review gate rejects a unit and feeds the corrective loop (Phase 2 §15.5)', async () => {
    const rejectVerdict = {
      adequate: false,
      findings: ['Objective "Model process lifecycles" is not taught by any scene'],
    };
    callLLMMock
      .mockResolvedValueOnce({ text: JSON.stringify(syllabusResponse()), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitOutlines(0)), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(rejectVerdict), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitOutlines(0)), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitReviewPass()), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitOutlines(1)), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitReviewPass()), usage: {} });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirements: REQUIREMENTS,
        sizePreset: 'standard',
        pdfText: '',
        pdfImages: [],
        imageMapping: {},
        researchContext: '',
      }) as unknown as Parameters<typeof POST>[0],
    );

    const text = await readStreamBody(response);
    const events = parseSseEvents(text);
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done.outlines).toHaveLength(TOTAL_SCENES);

    // syllabus + unit0 + reject-review + unit0-retry + pass-review + unit1 + review1.
    expect(callLLMMock).toHaveBeenCalledTimes(7);

    // The re-run's prompt carried the gate's findings.
    const retryPrompt = callLLMMock.mock.calls[3][0].prompt as string;
    expect(retryPrompt).toContain('unit review gate REJECTED');
    expect(retryPrompt).toContain('Model process lifecycles');

    // The gate's events surfaced the rejection and the acceptance.
    const reviewEvents = events.filter((e) => e.type === 'unitReview');
    expect(reviewEvents.map((e) => e.adequate)).toEqual([false, true, true]);
    expect(reviewEvents[0].findings[0]).toContain('Model process lifecycles');
  });

  test('unit review judge infra failure accepts the unit (best-effort gate)', async () => {
    callLLMMock
      .mockResolvedValueOnce({ text: JSON.stringify(syllabusResponse()), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitOutlines(0)), usage: {} })
      .mockRejectedValueOnce(new Error('judge model down'))
      .mockResolvedValueOnce({ text: JSON.stringify(unitOutlines(1)), usage: {} })
      .mockResolvedValueOnce({ text: JSON.stringify(unitReviewPass()), usage: {} });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirements: REQUIREMENTS,
        sizePreset: 'standard',
        pdfText: '',
        pdfImages: [],
        imageMapping: {},
        researchContext: '',
      }) as unknown as Parameters<typeof POST>[0],
    );

    const text = await readStreamBody(response);
    const events = parseSseEvents(text);
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done.outlines).toHaveLength(TOTAL_SCENES);
  });

  test('compact courses (single unit) keep the single-call streaming path', async () => {    streamLLMMock.mockImplementation(() => ({
      textStream: (async function* () {
        yield JSON.stringify({
          languageDirective: 'Teach in English.',
          courseTitle: 'Intro Course',
          lessons: [{ title: 'Lesson 1', objectives: ['obj'] }],
          audience: 'beginners',
          objectives: ['o1', 'o2'],
          outlines: Array.from({ length: 5 }, (_, i) => sceneOutline(`s${i + 1}`, i + 1)),
        });
      })(),
    }));

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirements: { requirement: 'Teach me the basics of git in 5 min' },
        pdfText: '',
        pdfImages: [],
        imageMapping: {},
        researchContext: '',
      }) as unknown as Parameters<typeof POST>[0],
    );

    const text = await readStreamBody(response);
    const events = parseSseEvents(text);
    expect(events.find((e) => e.type === 'done')).toBeDefined();
    expect(callLLMMock).not.toHaveBeenCalled();
    expect(streamLLMMock).toHaveBeenCalledTimes(1);
  });
});
