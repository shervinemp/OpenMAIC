import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  callLLM: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModel,
}));
vi.mock('@/lib/ai/llm', () => ({withAgenticOutputDiscipline: (value: string) => value, 
  callLLM: mocks.callLLM,
}));

import { readDecisionTelemetry, resetDecisionTelemetryForTests } from '@/lib/decision/telemetry';

let decisionHeaders: Record<string, string> = {};

/** The one Settings choice, expressed as request headers. */
function optIn(mode: 'replace' | 'shadow'): void {
  decisionHeaders = {
    'x-decision-enabled': '1',
    'x-decision-provider': 'laya',
    'x-decision-endpoint': 'http://127.0.0.1:8090',
    'x-decision-mode': mode,
  };
}

function post(url: string, body: unknown): NextRequest {
  return new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...decisionHeaders },
  }) as unknown as NextRequest;
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

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
  process.env.ALLOW_LOCAL_NETWORKS = 'true';
  resetDecisionTelemetryForTests();
  decisionHeaders = {};
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
  if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
  else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
  decisionHeaders = {};
  vi.unstubAllGlobals();
});

function decisionFetch(answers: Record<string, unknown>) {
  return vi.fn(async () => Response.json({ answers }));
}

describe('decision grading routes', () => {
  it('grades an exam answer with the decision model and skips the LLM in replace mode', async () => {
    optIn('replace');
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
    optIn('shadow');
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

  it('grades a short answer with the decision model in replace mode', async () => {
    optIn('replace');
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

  it('falls back to the LLM grading path when System 1 is not enabled', async () => {
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
