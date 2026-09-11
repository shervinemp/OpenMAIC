import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { NextRequest } from 'next/server';

function post(body: unknown, url = 'http://localhost/api/exam/grade-fr'): NextRequest {
  return new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }) as unknown as NextRequest;
}

const rubric = [
  { id: 'r1', criterion: 'Names the storage format tradeoff', weight: 'essential', lookFor: 'delta/parquet + openness' },
  { id: 'r2', criterion: 'Justifies compute split', weight: 'important', lookFor: 'storage/compute separation' },
];

describe('POST /api/exam/grade-fr', () => {
  let POST: typeof import('@/app/api/exam/grade-fr/route').POST;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mocks.resolveModel.mockResolvedValue({
      model: 'deepseek:deepseek-flash',
      modelInfo: undefined,
      modelString: 'deepseek:deepseek-flash',
      thinkingConfig: undefined,
    });
    ({ POST } = await import('@/app/api/exam/grade-fr/route'));
  });

  const body = (over: Record<string, unknown> = {}) => ({
    questionId: 'fr_1',
    prompt: 'Design a lakehouse for streaming analytics',
    userAnswer: 'A serious answer about delta storage and compute separation…',
    rubric: rubric,
    sampleAnswer: 'model answer',
    maxPoints: 10,
    withCriteria: true,
    ...over,
  });

  it('returns a clamped grade with per-criterion verdicts', async () => {
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify({
        score: 14,
        comment: 'Strong on storage, weak on compute.',
        criteria: [
          { id: 'r1', met: true, comment: 'Named delta + openness.' },
          { id: 'r2', met: false, comment: 'No compute split.' },
        ],
      }),
    });

    const res = await POST(post(body()) as never);
    expect(res.status).toBe(200);
    const j = JSON.parse(await (res as unknown as Response).text()) as {
      score: number;
      comment: string;
      criteria?: Array<{ id: string; met: boolean }>;
    };
    expect(j.score).toBe(10);
    expect(j.criteria?.[0]?.met).toBe(true);
    expect(j.criteria?.[1]?.met).toBe(false);
    expect(String(mocks.callLLM.mock.calls[0][0].prompt)).toContain('r1');
    expect(String(mocks.callLLM.mock.calls[0][0].prompt)).toContain('STUDENT ANSWER');
  });

  it('falls back to half credit with a notice when the grade JSON is unparseable', async () => {
    mocks.callLLM.mockResolvedValue({ text: 'not json at all' });
    const res = await POST(post(body()) as never);
    expect(res.status).toBe(200);
    const j = JSON.parse(await (res as unknown as Response).text()) as { score: number };
    expect(j.score).toBe(5);
  });

  it('400s when the answer is empty or the rubric is missing', async () => {
    const res1 = await POST(post(body({ userAnswer: '   ' })) as never);
    expect(res1.status).toBe(400);
    const res2 = await POST(post(body({ rubric: [] })) as never);
    expect(res2.status).toBe(400);
    const res3 = await POST(post(body({ maxPoints: -3 })) as never);
    expect(res3.status).toBe(400);
  });
});
