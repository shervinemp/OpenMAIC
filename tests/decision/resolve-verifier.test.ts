import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { QuizVerificationQuestion } from '@openmaic/generation';

import { resetDecisionTelemetryForTests } from '@/lib/decision/telemetry';
import { resolveQuizAnswerVerifier } from '@/lib/server/quiz-verifier';

const originalRoutes = process.env.DECISION_ROUTES;
const originalModelRoutes = process.env.MODEL_ROUTES;

const questions: QuizVerificationQuestion[] = [
  {
    id: 'q1',
    type: 'single',
    question: 'What stops recursion?',
    options: [
      { value: 'A', label: 'A base case' },
      { value: 'B', label: 'A larger input' },
    ],
  },
];

function request(withDecision = false): NextRequest {
  return new Request('http://localhost/api/generate/scene-content', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(withDecision
        ? {
            'x-decision-enabled': '1',
            'x-decision-provider': 'laya',
            'x-decision-endpoint': 'http://decision.test',
            'x-decision-mode': 'replace',
          }
        : {}),
    },
  }) as unknown as NextRequest;
}

beforeEach(() => {
  delete process.env.MODEL_ROUTES;
  resetDecisionTelemetryForTests();
});

afterEach(() => {
  if (originalRoutes === undefined) delete process.env.DECISION_ROUTES;
  else process.env.DECISION_ROUTES = originalRoutes;
  if (originalModelRoutes === undefined) delete process.env.MODEL_ROUTES;
  else process.env.MODEL_ROUTES = originalModelRoutes;
  vi.unstubAllGlobals();
});

describe('decision quiz verifier resolution', () => {
  it('returns a verifier from the Settings choice even without an LLM route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json({ answers: { q1: { choice: 'A', confidence: 0.96 } } }),
      ),
    );

    const verifier = await resolveQuizAnswerVerifier({
      req: request(true),
      log: { warn: vi.fn() },
    });
    expect(verifier).toBeTypeOf('function');
    await expect(verifier!(questions)).resolves.toEqual([{ id: 'q1', answers: ['A'] }]);
  });

  it('stays undefined with neither a decision route nor an LLM route', async () => {
    const verifier = await resolveQuizAnswerVerifier({
      req: request(),
      log: { warn: vi.fn() },
    });
    expect(verifier).toBeUndefined();
  });
});
