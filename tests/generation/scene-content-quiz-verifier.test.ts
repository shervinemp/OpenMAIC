import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { QuizQuestion } from '@openmaic/dsl';
import type { SceneOutline } from '@/lib/types/generation';

/**
 * The scene-content route wires the blind quiz verifier only when the
 * `quiz-verify` stage is routed. No route = no extra call; an unresolvable
 * route = generate without verification. The verifier's call is dispatched
 * through the same callLLM mock, so the source label proves which call ran.
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
const VERIFIER_MODEL = { provider: 'openai', modelId: 'gpt-verify' } as never;

function binding(model: unknown, modelString: string) {
  return {
    model,
    modelInfo: { outputWindow: 4096, capabilities: {} },
    modelString,
    thinkingConfig: undefined,
    serverManaged: true,
  };
}

function quizOutline(id: string): SceneOutline {
  return {
    id,
    type: 'quiz',
    title: 'Medallion checkpoint',
    description: 'Assess understanding of the bronze/silver/gold layers.',
    keyPoints: ['bronze', 'silver', 'gold'],
    order: 2,
    quizConfig: { questionCount: 2, difficulty: 'medium', questionTypes: ['single'] },
  };
}

function quiz(q1Key: string): QuizQuestion[] {
  return [
    {
      id: 'q1',
      type: 'single',
      question: 'Which layer keeps raw ingested data unchanged?',
      options: [
        { value: 'A', label: 'The bronze layer' },
        { value: 'B', label: 'The silver layer' },
        { value: 'C', label: 'The gold layer' },
      ],
      answer: [q1Key],
      analysis: 'Bronze holds the raw, unchanged ingestion output.',
      hasAnswer: true,
    },
    {
      id: 'q2',
      type: 'single',
      question: 'What does the medallion architecture enforce between layers?',
      options: [
        { value: 'A', label: 'Incremental quality improvements' },
        { value: 'B', label: 'Random sampling' },
        { value: 'C', label: 'Schema deletion' },
      ],
      answer: ['A'],
      analysis: 'Each layer adds quality guarantees.',
      hasAnswer: true,
    },
  ];
}

function mockRequest(outline: SceneOutline) {
  return {
    json: async () => ({
      outline,
      allOutlines: [outline],
      stageId: 'stage-1',
      stageInfo: { name: 'Test Stage' },
    }),
    headers: { get: () => null },
    signal: new AbortController().signal,
  } as never;
}

function sourceOf(call: unknown[]): string | undefined {
  return call[1] as string | undefined;
}

describe('scene-content quiz verifier wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.callLLM.mockReset();
    mocks.resolveModel.mockReset();
    mocks.resolveModelFromRequest.mockReset();
    mocks.resolveModelFromRequest.mockResolvedValue(binding(MAIN_MODEL, 'openai:gpt-main'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('routes a disagreement to the cheap verifier and re-prompts the quiz', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'quiz-verify': 'openai:gpt-verify' }));
    mocks.resolveModel.mockResolvedValue(binding(VERIFIER_MODEL, 'openai:gpt-verify'));
    let generations = 0;
    mocks.callLLM.mockImplementation(async (_params: unknown, source: string) => {
      if (source === 'quiz-verify') {
        return {
          text: JSON.stringify({
            answers: [
              { id: 'q1', answers: ['B'] },
              { id: 'q2', answers: ['A'] },
            ],
          }),
        };
      }
      generations += 1;
      return { text: JSON.stringify(quiz(generations === 1 ? 'A' : 'B')) };
    });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(mockRequest(quizOutline('route-quiz-verify')));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.content.questions[0].answer).toEqual(['B']);

    const sources = mocks.callLLM.mock.calls.map(sourceOf);
    expect(sources.filter((source) => source === 'scene-content')).toHaveLength(2);
    expect(sources.filter((source) => source === 'quiz-verify')).toHaveLength(2);
    const verifierCalls = mocks.callLLM.mock.calls.filter(
      (call) => sourceOf(call) === 'quiz-verify',
    );
    expect(verifierCalls[0]![0]).toMatchObject({ model: VERIFIER_MODEL });
  });

  test('makes no verifier call when the stage is not routed', async () => {
    mocks.callLLM.mockResolvedValue({ text: JSON.stringify(quiz('A')) });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(mockRequest(quizOutline('route-quiz-unrouted')));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(
      mocks.callLLM.mock.calls.filter((call) => sourceOf(call) === 'quiz-verify'),
    ).toHaveLength(0);
  });

  test('an unresolvable verifier route generates without verification', async () => {
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'quiz-verify': 'missing:model' }));
    mocks.resolveModel.mockRejectedValue(new Error('no credentials'));
    mocks.callLLM.mockResolvedValue({ text: JSON.stringify(quiz('A')) });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(mockRequest(quizOutline('route-quiz-unresolvable')));
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(body.content.questions[0].answer).toEqual(['A']);
    expect(
      mocks.callLLM.mock.calls.filter((call) => sourceOf(call) === 'quiz-verify'),
    ).toHaveLength(0);
  });
});
