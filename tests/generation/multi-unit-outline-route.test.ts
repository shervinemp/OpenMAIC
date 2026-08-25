import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const streamLLMMock = vi.hoisted(() => vi.fn());
const callLLMMock = vi.hoisted(() => vi.fn());
const resolveModelFromRequestMock = vi.hoisted(() => vi.fn());
const resolveModelMock = vi.hoisted(() => vi.fn());
const searchWebMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/llm', () => ({
  streamLLM: streamLLMMock,
  callLLM: callLLMMock,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: resolveModelFromRequestMock,
  resolveModel: resolveModelMock,
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
const SCENES_PER_LESSON = 10;
const LESSONS_PER_UNIT = 3;

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

/** Each lesson call returns its 10 outlines. */
function lessonOutlines(lessonIndex: number) {
  const outlines = [];
  for (let order = 1; order <= SCENES_PER_LESSON; order++) {
    outlines.push(sceneOutline(`l${lessonIndex}_s${order}`, order));
  }
  return { outlines };
}

/** The lesson review gate's accept verdict (Phase 2 §15.5). */
function unitReviewPass() {
  return { adequate: true, findings: [] };
}

// ── Parallel-aware mock dispatch ─────────────────────────────
// Lesson outline calls now run concurrently, so `mockResolvedValueOnce` order
// is nondeterministic. Dispatch on the prompt content instead.

const LESSON_TITLES = [
  'Process abstraction',
  'Threads',
  'Scheduling',
  'Address spaces',
  'Paging',
  'Page replacement',
];

function promptKind(prompt: string): 'syllabus' | 'outline' | 'review' {
  if (prompt.includes('Syllabus Context (Unit')) return 'outline';
  if (/Unit: [^\n]+/.test(prompt) && !prompt.includes('Syllabus Context')) return 'review';
  return 'syllabus';
}

function unitIndexOf(prompt: string): number {
  const m = prompt.match(/Syllabus Context \(Unit (\d+) of/);
  return m ? Number(m[1]) - 1 : -1;
}

function lessonInUnitIndexOf(prompt: string): number {
  const m = prompt.match(/Lesson (\d+) of \d+\)/);
  return m ? Number(m[1]) - 1 : -1;
}

/** Global lesson index (unit * lessons-per-unit + in-unit position). */
function globalLessonIndexOf(prompt: string): number {
  const u = unitIndexOf(prompt);
  const l = lessonInUnitIndexOf(prompt);
  if (u < 0 || l < 0) return -1;
  return u * LESSONS_PER_UNIT + l;
}

function unitTitleOf(prompt: string): string {
  const m = prompt.match(/Unit: ([^\n]+)/);
  return m ? m[1].trim() : '';
}

interface FlowResponses {
  syllabus?: Array<Record<string, unknown>>;
  /** per-lesson outline responses: (attempt) => response (default: lessonOutlines). */
  outline?: Record<number, (attempt: number) => unknown>;
  /** per-lesson review responses: (attempt) => response (default: unitReviewPass). */
  review?: Record<number, (attempt: number) => unknown>;
}

function setupMultiUnitFlow(flow: FlowResponses = {}) {
  const syllabus = flow.syllabus ?? [syllabusResponse()];
  let syllabusAttempt = 0;
  const outlineAttempt = new Map<number, number>();
  const reviewAttempt = new Map<number, number>();

  callLLMMock.mockImplementation(async (params: { prompt?: string }) => {
    const prompt = params.prompt ?? '';
    const kind = promptKind(prompt);

    if (kind === 'syllabus') {
      const idx = Math.min(syllabusAttempt, syllabus.length - 1);
      syllabusAttempt += 1;
      return { text: JSON.stringify(syllabus[idx]), usage: {} };
    }

    if (kind === 'outline') {
      const li = globalLessonIndexOf(prompt);
      const a = outlineAttempt.get(li) ?? 0;
      outlineAttempt.set(li, a + 1);
      const fn = flow.outline?.[li];
      return { text: JSON.stringify(fn ? fn(a) : lessonOutlines(li)), usage: {} };
    }

    const li = LESSON_TITLES.indexOf(unitTitleOf(prompt));
    const a = reviewAttempt.get(li) ?? 0;
    reviewAttempt.set(li, a + 1);
    const fn = flow.review?.[li];
    return { text: JSON.stringify(fn ? fn(a) : unitReviewPass()), usage: {} };
  });

  return { outlineAttempt, reviewAttempt };
}

describe('multi-unit outline route (Phase 2 §15.8)', () => {
  beforeEach(() => {
    resolveModelFromRequestMock.mockReset();
    resolveModelMock.mockReset();
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
    vi.unstubAllEnvs();
  });

  test('standard preset: syllabus call + per-unit calls assemble a valid blueprint', async () => {
    setupMultiUnitFlow();

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

    const lessonEvents = events.filter((e) => e.type === 'lesson');
    expect(lessonEvents).toHaveLength(6);
    expect(lessonEvents.map((e) => e.title)).toEqual(LESSON_TITLES);

    // Phase 2 §15.5: one review event per lesson, all accepted.
    const reviewEvents = events.filter((e) => e.type === 'unitReview');
    expect(reviewEvents).toHaveLength(6);
    expect(reviewEvents.every((e) => e.adequate)).toBe(true);

    const outlineEvents = events.filter((e) => e.type === 'outline');
    expect(outlineEvents).toHaveLength(TOTAL_SCENES);
    // Global numbering across lessons, no duplicates.
    const orders = outlineEvents.map((e) => e.data.order);
    expect(orders[0]).toBe(1);
    expect(orders[SCENES_PER_LESSON - 1]).toBe(SCENES_PER_LESSON);
    expect(orders[SCENES_PER_LESSON]).toBe(SCENES_PER_LESSON + 1);
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

  test('per-lesson prompt carries a lesson-scoped contract (correct global numbering + course-wide style guide)', async () => {
    setupMultiUnitFlow();

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
    await readStreamBody(response);

    // Find the outline call for global lesson 3 ("Address spaces", unit 1).
    const lesson3Prompt = callLLMMock.mock.calls
      .map((c) => (c[0] as { prompt?: string }).prompt ?? '')
      .find((p) => p.includes('Syllabus Context (Unit 2 of 2, Lesson 1 of 3)'));
    expect(lesson3Prompt).toBeDefined();

    // Lesson-scoped count with correct global numbering (30 prior scenes → #31..#40).
    expect(lesson3Prompt).toContain('You are generating LESSON 4 of 6');
    expect(lesson3Prompt).toContain('EXACTLY 10 scene outlines (global outline #31 through #40)');
    // Course-wide style guide still present (not silently dropped by the scoped renderer).
    expect(lesson3Prompt).toContain('Scene types:');
    expect(lesson3Prompt).toContain('Lesson scope note');
    // The old per-lesson regression: the 1-lesson contract must not render
    // "Produce EXACTLY 1 lessons" or lesson-relative "#1 through #10".
    expect(lesson3Prompt).not.toContain('Produce EXACTLY 1 lessons');
  });

  test('lessons within a unit are chained: later lessons get a "covered so far" summary, the first does not', async () => {
    setupMultiUnitFlow();

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
    await readStreamBody(response);

    const prompts = callLLMMock.mock.calls
      .map((c) => (c[0] as { prompt?: string }).prompt ?? '')
      .filter((p) => p.includes('Syllabus Context (Unit'));

    // The first lesson of each unit has no "covered so far" (nothing precedes it).
    const firstOfUnit1 = prompts.find((p) => p.includes('Lesson 1 of 3'));
    const firstOfUnit2 = prompts.find((p) => p.includes('Unit 2 of 2, Lesson 1 of 3'));
    expect(firstOfUnit1).toBeDefined();
    expect(firstOfUnit1).not.toContain('Covered so far in this unit');
    expect(firstOfUnit2).not.toContain('Covered so far in this unit');

    // The second lesson of unit 1 sees what lesson 1 covered.
    const secondOfUnit1 = prompts.find((p) => p.includes('Unit 1 of 2, Lesson 2 of 3'));
    expect(secondOfUnit1).toBeDefined();
    expect(secondOfUnit1).toContain('Covered so far in this unit (build on this; do NOT repeat it)');
    // Coverage is summarized from the prior lesson's scene titles.
    expect(secondOfUnit1).toContain('Process abstraction:');
  });

  test('OPENMAIC_OUTLINE_REVIEW_MODEL routes review calls through a separate judge model', async () => {
    vi.stubEnv('OPENMAIC_OUTLINE_REVIEW_MODEL', 'openai/gpt-4o-mini');
    const judgeModel = { provider: 'openai', modelId: 'judge-model' };
    resolveModelMock.mockResolvedValue({
      model: judgeModel,
      modelInfo: { outputWindow: 2048, capabilities: {} },
      thinkingConfig: undefined,
    });
    setupMultiUnitFlow();

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
    await readStreamBody(response);

    // The judge is resolved from the env-configured provider/model string.
    expect(resolveModelMock).toHaveBeenCalledWith({ modelString: 'openai/gpt-4o-mini' });

    const calls = callLLMMock.mock.calls.map(
      (c) => c[0] as { model?: unknown; system?: string },
    );
    const reviewCalls = calls.filter((c) => (c.system ?? '').includes('Unit Review Gate'));
    const generationCalls = calls.filter((c) => !(c.system ?? '').includes('Unit Review Gate'));
    expect(reviewCalls.length).toBeGreaterThan(0);
    expect(generationCalls.length).toBeGreaterThan(0);

    // Every review verdict comes from the judge; every syllabus/outline call
    // still uses the request's generator model.
    for (const call of reviewCalls) {
      expect(call.model).toBe(judgeModel);
    }
    for (const call of generationCalls) {
      expect(call.model).toEqual({ provider: 'openai', modelId: 'gpt-test' });
    }
  });

  test('syllabus corrective loop fixes the structure on retry', async () => {
    const wrongSyllabus = {
      ...syllabusResponse(),
      units: [
        { title: 'Only unit', objectives: ['x'], lessons: [{ title: 'L1', objectives: ['o'] }] },
      ],
    };
    setupMultiUnitFlow({ syllabus: [wrongSyllabus, syllabusResponse()] });

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
    // Syllabus retry + 6 lesson calls + 6 lesson reviews.
    expect(callLLMMock).toHaveBeenCalledTimes(14);
  });

  test('per-lesson corrective loop re-calls a lesson that missed its count', async () => {
    const shortLesson = { outlines: lessonOutlines(0).outlines.slice(0, 4) };
    setupMultiUnitFlow({ outline: { 0: (a) => (a === 0 ? shortLesson : lessonOutlines(0)) } });

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
    // Syllabus + lesson0 retry + lesson0 review + 5 remaining lessons (+ reviews).
    expect(callLLMMock).toHaveBeenCalledTimes(14);
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
    setupMultiUnitFlow();

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

    // One search per unit, queried from the unit title + objectives (order is
    // nondeterministic under parallelism, so assert set membership).
    expect(searchWebMock).toHaveBeenCalledTimes(2);
    const queries = searchWebMock.mock.calls.map((c) => (c[0] as { query: string }).query);
    expect(queries.some((q) => q.includes('Processes and Threads'))).toBe(true);
    expect(queries.some((q) => q.includes('Memory Management'))).toBe(true);

    // Unit 0 outlines carry retrieval context with web citations.
    const firstOutline = done.outlines[0];
    expect(firstOutline.retrievalContext).toBeDefined();
    expect(firstOutline.retrievalContext).toContain('[source 1]');
  });

  test('per-unit web research failure falls back to the global context without failing the run', async () => {
    searchWebMock.mockRejectedValue(new Error('search down'));
    setupMultiUnitFlow();

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

  test('lesson review gate rejects a lesson and feeds the corrective loop (Phase 2 §15.5)', async () => {
    const rejectVerdict = {
      adequate: false,
      findings: ['Objective "Model process lifecycles" is not taught by any scene'],
    };
    setupMultiUnitFlow({ review: { 0: (a) => (a === 0 ? rejectVerdict : unitReviewPass()) } });

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

    // syllabus + lesson0 (2 outlines + reject+pass reviews) + 5 lessons (+ reviews).
    expect(callLLMMock).toHaveBeenCalledTimes(15);

    // The re-run's prompt carried the gate's findings (order-independent lookup).
    const retryCall = callLLMMock.mock.calls.find((call) =>
      (call[0].prompt as string).includes('unit review gate REJECTED'),
    );
    expect(retryCall).toBeDefined();
    expect(retryCall![0].prompt as string).toContain('Model process lifecycles');

    // The gate's events surfaced the rejection and the acceptance.
    const reviewEvents = events.filter((e) => e.type === 'unitReview');
    expect(reviewEvents.map((e) => e.adequate)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(reviewEvents[0].findings[0]).toContain('Model process lifecycles');
  });

  test('tolerant gate (default): a lesson rejected on every attempt is accepted after the budget and the run completes', async () => {
    const rejectVerdict = {
      adequate: false,
      findings: ['Objective "Model process lifecycles" is not taught by any scene'],
    };
    // Lesson 0's judge rejects every attempt; the final rejection must NOT sink
    // the run — the lesson is accepted with the verdict marked acceptedAfterBudget.
    setupMultiUnitFlow({ review: { 0: () => rejectVerdict } });

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

    // syllabus + lesson0 (3 outlines + 3 reviews) + 5 lessons (outline + review).
    expect(callLLMMock).toHaveBeenCalledTimes(17);

    // Lesson 0's three rejections; only the budget-exhausting final one is
    // accepted-after-budget.
    const lesson0Reviews = events.filter((e) => e.type === 'unitReview' && e.index === 0);
    expect(lesson0Reviews).toHaveLength(3);
    expect(lesson0Reviews.map((e) => e.adequate)).toEqual([false, false, false]);
    expect(lesson0Reviews[0].acceptedAfterBudget).toBeUndefined();
    expect(lesson0Reviews[2].acceptedAfterBudget).toBe(true);

    // The remaining lessons passed on their single attempts.
    const otherReviews = events.filter((e) => e.type === 'unitReview' && e.index > 0);
    expect(otherReviews.map((e) => e.adequate)).toEqual([true, true, true, true, true]);
  });

  test('unparseable judge verdict accepts the unit (best-effort gate)', async () => {
    // A non-conforming judge response is a schema failure, not a rejection:
    // the unit is accepted without feeding the corrective loop.
    setupMultiUnitFlow({ review: { 0: () => ({ garbage: true }) } });

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

    // No retry for the unparseable verdict: syllabus + 6 lessons + 6 reviews.
    expect(callLLMMock).toHaveBeenCalledTimes(13);
  });

  test('unit review judge infra failure accepts the unit (best-effort gate)', async () => {
    setupMultiUnitFlow({ review: { 0: () => { throw new Error('judge model down'); } } });

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

  test('resumes a partial run from a checkpoint (skips syllabus + completed units)', async () => {
    // A prior run completed unit 0 (30 scenes) and checkpointed it. The resume
    // must reuse the syllabus and skip unit 0's lessons, generating only unit 1.
    setupMultiUnitFlow();

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirements: REQUIREMENTS,
        sizePreset: 'standard',
        pdfText: '',
        pdfImages: [],
        imageMapping: {},
        researchContext: '',
        resumeSyllabus: syllabusResponse(),
        resumeOutlines: [
          ...lessonOutlines(0).outlines,
          ...lessonOutlines(1).outlines,
          ...lessonOutlines(2).outlines,
        ].map((outline, index) => ({ ...outline, order: index + 1 })),
        resumeFromUnitIndex: 1,
      }) as unknown as Parameters<typeof POST>[0],
    );

    const text = await readStreamBody(response);
    const events = parseSseEvents(text);

    // The syllabus call and unit 0 are skipped: only unit 1's 3 lessons
    // generate (3 outline + 3 review calls).
    expect(callLLMMock).toHaveBeenCalledTimes(6);

    // The full ordered deck is reassembled: checkpointed outlines first.
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    expect(done.outlines).toHaveLength(TOTAL_SCENES);
    expect(done.outlines[0].id).toBe('l0_s1');
    expect(done.outlines[SCENES_PER_UNIT].id).toBe('l3_s1');

    // A unitDone event marks the newly-completed unit for the next checkpoint.
    const unitDone = events.filter((e) => e.type === 'unitDone');
    expect(unitDone.map((e) => e.index)).toEqual([1]);
  });

  test('compact single-unit courses take the syllabus-first path too', async () => {
    // Contract mode ALWAYS uses the syllabus + per-lesson chains for ordinary
    // courses now — the single mega-call broke weak models outright. The
    // 5-minute contract derives 1 unit / 1 lesson / 5 scenes; the flow mocks
    // must match that shape exactly.
    const singleUnitSyllabus = {
      languageDirective: 'Teach in English.',
      courseTitle: 'Git Basics',
      audience: 'beginners',
      objectives: ['Understand version control', 'Collaborate with branches'],
      units: [
        {
          title: 'Git Fundamentals',
          objectives: ['Track changes'],
          lessons: [{ title: 'Git Fundamentals', objectives: ['Commit and branch'] }],
        },
      ],
    };
    const compactOutlines = {
      outlines: Array.from({ length: 5 }, (_, i) => sceneOutline(`s${i + 1}`, i + 1)),
    };
    setupMultiUnitFlow({
      syllabus: [singleUnitSyllabus],
      outline: { 0: () => compactOutlines },
    });

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
    // The staged path runs entirely on callLLM (syllabus + per-lesson calls +
    // review gate); the streaming mega-call stays unused.
    expect(callLLMMock).toHaveBeenCalled();
    expect(streamLLMMock).not.toHaveBeenCalled();
  });
});

