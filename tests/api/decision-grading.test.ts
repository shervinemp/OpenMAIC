import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  callLLM: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModel,
}));
vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
}));

import { resetDecisionConfigForTests } from '@/lib/decision/config';
import { readDecisionTelemetry, resetDecisionTelemetryForTests } from '@/lib/decision/telemetry';

const originalRoutes = process.env.DECISION_ROUTES;
const originalEnabled = process.env.DECISION_MODELS_ENABLED;

function setDecisionRoutes(routes: unknown): void {
  process.env.DECISION_ROUTES = JSON.stringify(routes);
  resetDecisionConfigForTests();
}

function post(url: string, body: unknown): NextRequest {
  return new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }) as unknown as NextRequest;
}

const rubric = [
  {
    id: 'r1',
    criterion: 'Names the storage format tradeoff',
    weight: 'essential',
    lookFor: 'delta/parquet',
  },
  {
    id: 'r2',
    criterion: 'Justifies compute split',
    weight: 'important',
    lookFor: 'storage/compute separation',
  },
];

const examBody = {
  questionId: 'fr_1',
  prompt: 'Design a lakehouse for streaming analytics',
  userAnswer: 'Delta storage with separated compute.',
  rubric,
  sampleAnswer: 'A layered lakehouse.',
  maxPoints: 10,
  withCriteria: true,
};

const quizBody = {
  question: 'Explain why a process needs its own address space.',
  userAnswer: 'It isolates memory so faults do not spread.',
  points: 10,
};

beforeEach(() => {
  resetDecisionConfigForTests();
  resetDecisionTelemetryForTests();
  mocks.resolveModel.mockReset();
  mocks.callLLM.mockReset();
  mocks.resolveModel.mockResolvedValue({
    model: 'test:model',
    modelInfo: { outputWindow: 64_000, capabilities: {} },
    modelString: 'test:model',
    thinkingConfig: undefined,
    serverManaged: true,
  });
});

afterEach(() => {
  if (originalRoutes === undefined) delete process.env.DECISION_ROUTES;
  else process.env.DECISION_ROUTES = originalRoutes;
  if (originalEnabled === undefined) delete process.env.DECISION_MODELS_ENABLED;
  else process.env.DECISION_MODELS_ENABLED = originalEnabled;
  resetDecisionConfigForTests();
  vi.unstubAllGlobals();
});

function decisionFetch(answers: Record<string, unknown>) {
  return vi.fn(async () => Response.json({ answers }));
}

describe('decision grading routes', () => {
  it('grades an exam answer with the decision model and skips the LLM in replace mode', async () => {
    setDecisionRoutes({
      'exam-grading': {
        provider: 'laya',
        endpoint: 'http://decision.test',
        mode: 'replace',
      },
    });
    const fetchMock = decisionFetch({
      r1: { noul: 0.95, confidence: 0.98 },
      r2: { noul: 0.9, confidence: 0.96 },
      __score: { score: 10, confidence: 0.97 },
    });
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('@/app/api/exam/grade-fr/route');
    const response = await POST(post('http://localhost/api/exam/grade-fr', examBody) as never);
    const body = (await response.json()) as {
      score: number;
      comment: string;
      criteria: Array<{ id: string; met: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(body.score).toBe(10);
    expect(body.comment).toBe('');
    expect(body.criteria.map((criterion) => criterion.met)).toEqual([true, true]);
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readDecisionTelemetry()[0]?.key).toBe('exam-grading|laya|replace|decision');
  });

  it('returns the LLM grade in shadow mode and records the disagreement', async () => {
    setDecisionRoutes({
      'exam-grading': {
        provider: 'laya',
        endpoint: 'http://decision.test',
        mode: 'shadow',
      },
    });
    vi.stubGlobal(
      'fetch',
      decisionFetch({
        r1: { noul: 0.95, confidence: 0.98 },
        r2: { noul: 0.9, confidence: 0.96 },
        __score: { score: 10, confidence: 0.97 },
      }),
    );
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify({
        score: 8,
        comment: 'Strong but incomplete.',
        criteria: [
          { id: 'r1', met: true, comment: 'ok' },
          { id: 'r2', met: false, comment: 'missing' },
        ],
      }),
    });

    const { POST } = await import('@/app/api/exam/grade-fr/route');
    const response = await POST(post('http://localhost/api/exam/grade-fr', examBody) as never);
    const body = (await response.json()) as { score: number; comment: string };

    expect(response.status).toBe(200);
    expect(body.score).toBe(8);
    expect(body.comment).toContain('Strong');
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(readDecisionTelemetry()[0]?.key).toBe('exam-grading|laya|shadow|shadow-disagree');
  });

  it('returns 502 rather than inventing a grade when fallback is disabled', async () => {
    setDecisionRoutes({
      'exam-grading': {
        provider: 'laya',
        endpoint: 'http://decision.test',
        mode: 'replace',
        fallback: 'none',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 500 })),
    );

    const { POST } = await import('@/app/api/exam/grade-fr/route');
    const response = await POST(post('http://localhost/api/exam/grade-fr', examBody) as never);

    expect(response.status).toBe(502);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('grades a short answer with the decision model in replace mode', async () => {
    setDecisionRoutes({
      'quiz-grade': {
        provider: 'laya',
        endpoint: 'http://decision.test',
        mode: 'replace',
      },
    });
    vi.stubGlobal('fetch', decisionFetch({ __score: { score: 7, confidence: 0.94 } }));

    const { POST } = await import('@/app/api/quiz-grade/route');
    const response = await POST(post('http://localhost/api/quiz-grade', quizBody) as never);
    const body = (await response.json()) as { score: number; comment: string };

    expect(response.status).toBe(200);
    expect(body.score).toBe(7);
    expect(body.comment).toBe('');
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.resolveModel).not.toHaveBeenCalled();
  });

  it('keeps the LLM grading path when the kill switch is off', async () => {
    setDecisionRoutes({
      'quiz-grade': {
        provider: 'laya',
        endpoint: 'http://decision.test',
        mode: 'replace',
      },
    });
    process.env.DECISION_MODELS_ENABLED = 'false';
    resetDecisionConfigForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify({ score: 4, comment: 'Mostly right.' }),
    });

    const { POST } = await import('@/app/api/quiz-grade/route');
    const response = await POST(post('http://localhost/api/quiz-grade', quizBody) as never);
    const body = (await response.json()) as { score: number };

    expect(response.status).toBe(200);
    expect(body.score).toBe(4);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
  });
});
