import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decisionConfigFromRequest } from '@/lib/decision/request-config';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/quiz-grade', { headers });
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

beforeEach(() => {
  process.env.ALLOW_LOCAL_NETWORKS = 'true';
});

afterEach(() => {
  if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
  else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
});

describe('per-request decision model selection', () => {
  it('is off unless the user opted in', async () => {
    expect(await decisionConfigFromRequest(req(), 'quiz-grade')).toBeUndefined();
    expect(
      await decisionConfigFromRequest(
        req({ 'x-decision-enabled': '0', 'x-decision-model': 'openai:gpt-5' }),
        'quiz-grade',
      ),
    ).toBeUndefined();
  });

  it('uses exactly the one selected provider:model with an LLM fallback', async () => {
    const config = await decisionConfigFromRequest(
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

  it('honors replace mode', async () => {
    const config = await decisionConfigFromRequest(
      req({
        'x-decision-enabled': '1',
        'x-decision-model': 'google:gemini-2.5-flash',
        'x-decision-mode': 'replace',
      }),
      'exam-grading',
    );
    expect(config?.mode).toBe('replace');
  });

  it('supports typed decision servers (Laya/Jev) through the same headers', async () => {
    for (const provider of ['laya', 'jev']) {
      const config = await decisionConfigFromRequest(
        req({
          'x-decision-enabled': '1',
          'x-decision-provider': provider,
          'x-decision-endpoint': 'http://127.0.0.1:8090',
          'x-decision-mode': 'replace',
        }),
        'claim-check',
      );
      expect(config).toMatchObject({
        site: 'claim-check',
        provider,
        endpoint: 'http://127.0.0.1:8090',
        mode: 'replace',
        fallback: 'llm',
      });
    }
  });

  it('rejects unsafe typed endpoints before the server fetches them', async () => {
    for (const endpoint of [
      'file:///etc/passwd',
      'http://169.254.169.254/latest/meta-data',
      'http://127.0.0.1:8090/predict?x=1',
      'javascript:alert(1)',
    ]) {
      expect(
        await decisionConfigFromRequest(
          req({
            'x-decision-enabled': '1',
            'x-decision-provider': 'laya',
            'x-decision-endpoint': endpoint,
          }),
          'quiz-grade',
        ),
      ).toBeUndefined();
    }
  });

  it('rejects a bare model id or an empty selection', async () => {
    expect(
      await decisionConfigFromRequest(
        req({ 'x-decision-enabled': '1', 'x-decision-model': 'gpt-5' }),
        'quiz-grade',
      ),
    ).toBeUndefined();
    expect(
      await decisionConfigFromRequest(req({ 'x-decision-enabled': '1' }), 'quiz-grade'),
    ).toBeUndefined();
  });
});
