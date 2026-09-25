import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  callLLM: vi.fn(),
  saved: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModel,
}));
vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { NextRequest } from 'next/server';
import type { ExamKind, ExamSpec } from '@/lib/types/exam';

/** Every prompt the exam-generation route fed to callLLM. */
function mockPrompts(): string[] {
  return mocks.callLLM.mock.calls.map((c) => (c[0] as { prompt: string }).prompt);
}

function post(body: unknown, url = 'http://localhost/api/exam/grade-fr'): NextRequest {
  return new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }) as unknown as NextRequest;
}

const enrollmentBlueprint = (kind: ExamKind): { blueprint: unknown; covered: unknown[] } => {
  const courseBlueprint = {
    title: 'Databricks Foundations',
    audience: 'data engineers',
    languageDirective: 'Write in English.',
    units: [
      {
        title: 'U1',
        objectives: ['o1'],
        durationMinutes: 50,
        sceneTarget: 13,
        lessons: [
          {
            title: 'L1',
            objectives: [],
            durationMinutes: 13,
            sceneTarget: 13,
            outlines: [
              { id: 's1', type: 'slide', title: 'Lakehouse basics', description: 'd', keyPoints: ['delta'], order: 1 },
              { id: 's2', type: 'quiz', title: 'Q on lakehouse', description: 'd', keyPoints: [], order: 2, quizConfig: {} as never },
            ],
          },
        ],
      },
    ],
    lessons: [],
  };
  const covered = kind === 'midterm'
    ? courseBlueprint.units.flatMap((u) => u.lessons.flatMap((l) => l.outlines))
    : courseBlueprint.units.flatMap((u) => u.lessons.flatMap((l) => l.outlines));
  return { blueprint: courseBlueprint, covered };
};

describe('POST /api/generate/exam', () => {
  let POST: typeof import('@/app/api/generate/exam/route').POST;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mocks.callLLM.mockClear();
    mocks.resolveModel.mockClear();
    mocks.resolveModel.mockResolvedValue({
      model: 'deepseek:deepseek-flash',
      modelInfo: undefined,
      modelString: 'deepseek:deepseek-flash',
      thinkingConfig: undefined,
    });
    ({ POST } = await import('@/app/api/generate/exam/route'));
  });

  const genBody = (kind: ExamKind = 'midterm') => {
    const enrollment = enrollmentBlueprint(kind);
    return {
      kind,
      blueprint: enrollment.blueprint,
      coveredOutlines: enrollment.covered,
      languageDirective: 'English',
    };
  };

  it('coerces the LLM JSON into a validated ExamSpec', async () => {
    const rawExam = {
      mcQuestions: Array.from({ length: 12 }, (_, i) => ({
        question: `Scenario ${i + 1}: choose carefully`,
        options: [
          { label: 'opt A', value: 'A' },
          { label: 'opt B', value: 'B' },
          { label: 'opt C', value: 'C' },
          { label: 'opt D', value: 'D' },
        ],
        answer: ['A'],
        analysis: 'Because A is right; B is a common misconception.',
      })),
      frQuestions: [
        {
          prompt: 'Design a lakehouse for streaming analytics',
          guidance: ['cite constraints'],
          rubric: [
            { id: 'r1', criterion: 'Names storage format tradeoffs', weight: 'essential', lookFor: 'delta/parquet reasons' },
            { id: 'r2', criterion: 'Justifies compute split', weight: 'important', lookFor: 'separation of storage/compute' },
          ],
          sampleAnswer: 'A good answer explains…',
          maxPoints: 10,
        },
        {
          prompt: 'Second written task',
          rubric: [
            { id: 'r3', criterion: 'criterion one', weight: 'essential', lookFor: 'look1' },
            { id: 'r4', criterion: 'criterion two', weight: 'important', lookFor: 'look2' },
          ],
          sampleAnswer: 'model',
        },
        {
          prompt: 'Third written task',
          rubric: [
            { criterion: 'c3', weight: 'essential', lookFor: 'l3' },
            { criterion: 'c4', weight: 'important', lookFor: 'l4' },
          ],
          sampleAnswer: 's3',
        },
      ],
    };
    mocks.callLLM.mockResolvedValue({ text: JSON.stringify(rawExam) });

    const res = await POST(post(genBody()) as never);
    expect(res.status).toBe(200);
    const bodyText = await (res as unknown as Response).text();
    const j = JSON.parse(bodyText) as { exam?: ExamSpec; success?: boolean };
    expect(j.success).toBe(true);
    expect(j.exam?.kind).toBe('midterm');
    expect(j.exam?.mcQuestions.length).toBe(12);
    expect(j.exam?.frQuestions.length).toBe(3);
    expect(j.exam?.mcQuestions[0].answer).toEqual(['A']);
    expect(j.exam?.frQuestions[0].rubric.length).toBe(2);
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
  });

  it('re-prompts once when the first spec lacks MC questions, then succeeds', async () => {
    const shortExam = {
      mcQuestions: Array.from({ length: 2 }, (_, i) => ({
        question: `too few ${i}`,
        options: [{ label: 'a', value: 'A' }, { label: 'b', value: 'B' }],
        answer: ['A'],
        analysis: 'x',
      })),
      frQuestions: [],
    };
    const fullExam = {
      mcQuestions: Array.from({ length: 12 }, (_, i) => ({
        question: `Scenario ${i + 1}`,
        options: [{ label: 'a', value: 'A' }, { label: 'b', value: 'B' }, { label: 'c', value: 'C' }, { label: 'd', value: 'D' }],
        answer: ['A'],
        analysis: 'x',
      })),
      frQuestions: [
        { prompt: 'fr1', rubric: [{ id: 'r1', criterion: 'c', weight: 'essential', lookFor: 'l' }, { id: 'r2', criterion: 'c2', weight: 'important', lookFor: 'l2' }], sampleAnswer: 's' },
        { prompt: 'fr2', rubric: [{ id: 'r3', criterion: 'c3', weight: 'essential', lookFor: 'l3' }, { id: 'r4', criterion: 'c4', weight: 'important', lookFor: 'l4' }], sampleAnswer: 's2' },
        { prompt: 'fr3', rubric: [{ id: 'r5', criterion: 'c5', weight: 'essential', lookFor: 'l5' }, { id: 'r6', criterion: 'c6', weight: 'important', lookFor: 'l6' }], sampleAnswer: 's3' },
      ],
    };
    mocks.callLLM
      .mockResolvedValueOnce({ text: JSON.stringify(shortExam) })
      .mockResolvedValueOnce({ text: JSON.stringify(fullExam) });

    const res = await POST(post(genBody('final')) as never);
    expect(res.status).toBe(200);
    const bodyText = await (res as unknown as Response).text();
    const j = JSON.parse(bodyText) as { exam?: ExamSpec };
    expect(j.exam?.mcQuestions.length).toBe(12);
    expect(j.exam?.frQuestions.length).toBe(3);
    // Retry prompt must contain the shortfall findings.
    expect(mockPrompts()[1] ?? '').toContain('CONSTRAINT VIOLATION REPORT');
    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
  });


  it('rejects a spec that is still short after the corrective retry', async () => {
    const shortExam = {
      mcQuestions: Array.from({ length: 4 }, () => ({
        question: 'q',
        options: [{ label: 'a', value: 'A' }, { label: 'b', value: 'B' }, { label: 'c', value: 'C' }, { label: 'd', value: 'D' }],
        answer: ['A'],
        analysis: 'x',
      })),
      frQuestions: [],
    };
    mocks.callLLM.mockResolvedValue({ text: JSON.stringify(shortExam) });
    const res = await POST(post(genBody()) as never);
    expect(res.status).toBe(502);
  });

  it('400s when kind or blueprint are missing', async () => {
    const res = await POST(post({ kind: 'nope' }) as never);
    expect(res.status).toBe(400);
  });
});
