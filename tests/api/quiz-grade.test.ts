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

  it('repairs a fenced JSON reply with a trailing comma', async () => {
    mocks.callLLM.mockResolvedValueOnce({
      text: '```json\n{"score": 4, "comment": "Good answer.",}\n```',
    });
    const res = await POST(post(validBody) as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.score).toBe(4);
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
  });

  it('salvages an explicit prose score instead of inventing half credit', async () => {
    mocks.callLLM.mockResolvedValueOnce({
      text: 'This is mostly right. Score: 4 of 5.',
    });
    const res = await POST(post(validBody) as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.score).toBe(4);
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
  });

  it('ignores a ratio whose denominator is not this question maximum', async () => {
    // "2 of 3 criteria" is not a score out of 5; the reply is unreadable.
    mocks.callLLM.mockResolvedValue({ text: 'The answer met 2 of 3 criteria.' });
    const res = await POST(post(validBody) as never);
    expect(res.status).toBe(502);
  });

  it('re-prompts once when the reply is unreadable, then accepts the corrected grade', async () => {
    mocks.callLLM
      .mockResolvedValueOnce({ text: 'I think this deserves a good mark.' })
      .mockResolvedValueOnce({ text: JSON.stringify({ score: 3, comment: 'Partially right.' }) });

    const res = await POST(post(validBody) as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.score).toBe(3);
    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
    const retryPrompt = mocks.callLLM.mock.calls[1]![0] as { prompt?: string };
    expect(retryPrompt.prompt).toContain('could not be parsed');
    expect(retryPrompt.prompt).toContain('JSON');
  });

  it('returns 502 instead of fabricating a score after the retry is unreadable too', async () => {
    mocks.callLLM.mockResolvedValue({ text: 'A thoughtful but unscored reply.' });
    const res = await POST(post(validBody) as never);
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.success).toBe(false);
    expect(body.error).toContain('unreadable');
    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
  });

  it('does not turn a missing JSON score into zero', async () => {
    mocks.callLLM.mockResolvedValue({ text: JSON.stringify({ comment: 'Nice work.' }) });
    const res = await POST(post(validBody) as never);
    expect(res.status).toBe(502);
    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
  });

  it('clamps a score above the question maximum', async () => {
    mocks.callLLM.mockResolvedValueOnce({ text: JSON.stringify({ score: 99, comment: 'Great.' }) });
    const res = await POST(post(validBody) as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.score).toBe(5);
  });

  it('preserves an upstream provider status', async () => {
    mocks.callLLM.mockRejectedValueOnce(Object.assign(new Error('down'), { statusCode: 503 }));
    const res = await POST(post(validBody) as never);
    expect(res.status).toBe(503);
    expect((await res.json()).success).toBe(false);
  });
});
