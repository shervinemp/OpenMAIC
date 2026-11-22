import { describe, expect, it } from 'vitest';

import { decisionConfigFromRequest } from '@/lib/decision/request-config';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/quiz-grade', { headers });
}

describe('per-request decision model selection', () => {
  it('is off unless the user opted in', () => {
    expect(decisionConfigFromRequest(req(), 'quiz-grade')).toBeUndefined();
    expect(
      decisionConfigFromRequest(req({ 'x-decision-enabled': '0', 'x-decision-model': 'openai:gpt-5' }), 'quiz-grade'),
    ).toBeUndefined();
  });

  it('uses exactly the one selected provider:model with an LLM fallback', () => {
    const config = decisionConfigFromRequest(
      req({
        'x-decision-enabled': '1',
        'x-decision-model': 'openai:gpt-5',
      }),
      'quiz-grade',
    );

    expect(config).toMatchObject({
      site: 'quiz-grade',
      provider: 'chat',
      model: 'openai:gpt-5',
      mode: 'shadow',
      fallback: 'llm',
    });
  });

  it('honors replace mode', () => {
    const config = decisionConfigFromRequest(
      req({
        'x-decision-enabled': '1',
        'x-decision-model': 'google:gemini-2.5-flash',
        'x-decision-mode': 'replace',
      }),
      'exam-grading',
    );
    expect(config?.mode).toBe('replace');
  });

  it('rejects a bare model id or an empty selection', () => {
    expect(
      decisionConfigFromRequest(
        req({ 'x-decision-enabled': '1', 'x-decision-model': 'gpt-5' }),
        'quiz-grade',
      ),
    ).toBeUndefined();
    expect(
      decisionConfigFromRequest(req({ 'x-decision-enabled': '1' }), 'quiz-grade'),
    ).toBeUndefined();
  });
});
