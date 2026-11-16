import { beforeEach, describe, expect, it, vi } from 'vitest';
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

function post(body: unknown): NextRequest {
  return new Request('http://localhost/api/quiz-grade', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }) as unknown as NextRequest;
}

const validBody = {
  question: 'Explain why a process needs its own address space.',
  userAnswer: 'It isolates memory so a fault in one process cannot corrupt another.',
  points: 5,
};

describe('POST /api/quiz-grade', () => {
  let POST: typeof import('@/app/api/quiz-grade/route').POST;

  beforeEach(async () => {
    mocks.resolveModel.mockReset();
    mocks.callLLM.mockReset();
    mocks.resolveModel.mockResolvedValue({
      model: 'test:model',
      modelInfo: { outputWindow: 64000, capabilities: {} },
      modelString: 'test:model',
      thinkingConfig: undefined,
      serverManaged: true,
    });
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify({ score: 4, comment: 'Mostly right.' }),
    });
    ({ POST } = await import('@/app/api/quiz-grade/route'));
  });

  it('rejects an oversized question or answer before calling the model', async () => {
    const longQuestion = await POST(post({ ...validBody, question: 'Q'.repeat(12_001) }) as never);
    expect(longQuestion.status).toBe(413);

    const longAnswer = await POST(post({ ...validBody, userAnswer: 'A'.repeat(24_001) }) as never);
    expect(longAnswer.status).toBe(413);

    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('rejects a non-string question without throwing', async () => {
    const res = await POST(post({ ...validBody, question: 42 }) as never);
    expect(res.status).toBe(400);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('caps the grading output budget', async () => {
    const res = await POST(post(validBody) as never);
    expect(res.status).toBe(200);
    expect(mocks.callLLM.mock.calls[0]![0]).toMatchObject({ maxOutputTokens: 2_000 });
  });
});
