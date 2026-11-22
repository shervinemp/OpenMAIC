import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Exam MC keys are verified with the same blind-solve stage as scene quizzes.
 * The verifier only sees stems/options; a disagreement buys one corrective
 * re-prompt, and a persistent disagreement keeps the generated key.
 */

const mocks = vi.hoisted(() => ({
  resolveRequest: vi.fn(),
  resolveStage: vi.fn(),
  callLLM: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveRequest,
  resolveModel: mocks.resolveStage,
}));
vi.mock('@/lib/ai/llm', () => ({withAgenticOutputDiscipline: (value: string) => value,  callLLM: mocks.callLLM }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import type { NextRequest } from 'next/server';

const MAIN_MODEL = { provider: 'openai', modelId: 'gpt-main' } as never;
const VERIFIER_MODEL = { provider: 'openai', modelId: 'gpt-verify' } as never;

function binding(model: unknown, modelString: string) {
  return {
    model,
    modelInfo: { outputWindow: 64_000, capabilities: {} },
    modelString,
    thinkingConfig: undefined,
    serverManaged: true,
  };
}

function mc(index: number, key: string) {
  return {
    question: `Scenario ${index}: choose the best answer.`,
    options: [
      { label: 'option A', value: 'A' },
      { label: 'option B', value: 'B' },
      { label: 'option C', value: 'C' },
      { label: 'option D', value: 'D' },
    ],
    answer: [key],
    analysis: 'A is correct; B is a common misconception.',
  };
}

function fr(index: number) {
  return {
    prompt: `Free response ${index}`,
    rubric: [
      { id: `r${index}a`, criterion: 'criterion one', weight: 'essential', lookFor: 'look one' },
      { id: `r${index}b`, criterion: 'criterion two', weight: 'important', lookFor: 'look two' },
    ],
    sampleAnswer: 'A complete answer.',
    maxPoints: 10,
  };
}

function exam(q1Key: string) {
  return {
    mcQuestions: Array.from({ length: 18 }, (_, i) => mc(i + 1, i === 0 ? q1Key : 'A')),
    frQuestions: [fr(1), fr(2), fr(3), fr(4), fr(5)],
  };
}

/** Blind verdicts: mc_1 differs, every other MC key matches. */
function verifierVerdicts(q1Key: string) {
  return {
    answers: [
      { id: 'mc_1', answers: [q1Key] },
      ...Array.from({ length: 17 }, (_, i) => ({ id: `mc_${i + 2}`, answers: ['A'] })),
    ],
  };
}

function mockRequest() {
  return {
    json: async () => ({
      kind: 'midterm',
      blueprint: { title: 'Exam course', audience: 'learners', units: [] },
      coveredOutlines: [],
      languageDirective: 'English',
    }),
    headers: { get: () => null },
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

async function postExam() {
  const { POST } = await import('@/app/api/generate/exam/route');
  return POST(mockRequest());
}

function sources(): Array<string | undefined> {
  return mocks.callLLM.mock.calls.map((call) => call[1] as string | undefined);
}

describe('exam MC blind verification', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.resolveRequest.mockReset();
    mocks.resolveStage.mockReset();
    mocks.callLLM.mockReset();
    mocks.resolveRequest.mockResolvedValue(binding(MAIN_MODEL, 'openai:gpt-main'));
    mocks.resolveStage.mockResolvedValue(binding(VERIFIER_MODEL, 'openai:gpt-verify'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('corrects a wrong MC key through one re-prompt', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'quiz-verify': 'openai:gpt-verify' }));
    let generations = 0;
    mocks.callLLM.mockImplementation(async (_params: unknown, source: string) => {
      if (source === 'quiz-verify') {
        return { text: JSON.stringify(verifierVerdicts('B')) };
      }
      generations += 1;
      return { text: JSON.stringify(exam(generations === 1 ? 'A' : 'B')) };
    });

    const response = await postExam();
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.exam.mcQuestions[0].answer).toEqual(['B']);
    expect(sources().filter((source) => source === 'exam-generation')).toHaveLength(2);
    expect(sources().filter((source) => source === 'quiz-verify')).toHaveLength(2);
    expect(mocks.callLLM.mock.calls[0]![0]).toMatchObject({ model: MAIN_MODEL });
    const verifierCall = mocks.callLLM.mock.calls.find((call) => call[1] === 'quiz-verify');
    expect(verifierCall?.[0]).toMatchObject({ model: VERIFIER_MODEL });
  });

  test('makes no verifier call when the stage is not routed', async () => {
    mocks.callLLM.mockResolvedValue({ text: JSON.stringify(exam('A')) });

    const response = await postExam();
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(mocks.resolveStage).not.toHaveBeenCalled();
    expect(sources().filter((source) => source === 'quiz-verify')).toHaveLength(0);
  });

  test('fails open when the verifier errors', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'quiz-verify': 'openai:gpt-verify' }));
    mocks.callLLM.mockImplementation(async (_params: unknown, source: string) => {
      if (source === 'quiz-verify') throw new Error('verifier down');
      return { text: JSON.stringify(exam('A')) };
    });

    const response = await postExam();
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.exam.mcQuestions[0].answer).toEqual(['A']);
    expect(sources().filter((source) => source === 'exam-generation')).toHaveLength(1);
  });

  test('keeps the generated key when the retry still disagrees', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'quiz-verify': 'openai:gpt-verify' }));
    mocks.callLLM.mockImplementation(async (_params: unknown, source: string) => {
      if (source === 'quiz-verify') {
        return { text: JSON.stringify(verifierVerdicts('B')) };
      }
      return { text: JSON.stringify(exam('A')) };
    });

    const response = await postExam();
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.exam.mcQuestions[0].answer).toEqual(['A']);
    expect(sources().filter((source) => source === 'exam-generation')).toHaveLength(2);
  });
});
