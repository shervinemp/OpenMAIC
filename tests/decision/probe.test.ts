import { beforeEach, describe, expect, it, vi } from 'vitest';

import { probeDecisionSites } from '@/lib/decision/probe';
import { TypedDecisionResponseError } from '@/lib/decision/providers/laya';
import { readDecisionTelemetry, resetDecisionTelemetryForTests } from '@/lib/decision/telemetry';
import type {
  DecisionProvider,
  DecisionResult,
  DecisionSiteConfig,
  DecisionSiteId,
} from '@/lib/decision/types';

function config(over: Partial<DecisionSiteConfig> = {}): DecisionSiteConfig {
  return {
    site: 'quiz-verify',
    provider: 'laya',
    mode: 'replace',
    endpoint: 'http://127.0.0.1:8090',
    timeoutMs: 1_000,
    minConfidence: 0.9,
    maxInputChars: 10_000,
    fallback: 'llm',
    ...over,
  };
}

function result(): DecisionResult {
  return {
    provider: 'fake',
    answers: new Map([['probe', { kind: 'noul' as const, probability: 0.5, confidence: 0.5 }]]),
    abstained: new Set(),
    latencyMs: 7,
  };
}

function mapOf(...configs: DecisionSiteConfig[]): Map<DecisionSiteId, DecisionSiteConfig> {
  return new Map(configs.map((entry) => [entry.site, entry]));
}

beforeEach(() => {
  resetDecisionTelemetryForTests();
});

describe('decision site probe', () => {
  it('reports a reachable typed site and uses the adapter latency', async () => {
    const createProvider = vi.fn(
      (): DecisionProvider => ({ id: 'fake', decide: async () => result() }),
    );

    const probes = await probeDecisionSites({
      configs: mapOf(config()),
      createProvider,
    });

    expect(probes).toEqual([
      {
        site: 'quiz-verify',
        provider: 'laya',
        mode: 'replace',
        status: 'ok',
        latencyMs: 7,
        detail: 'answer received',
      },
    ]);
  });

  it('reports an unreachable typed site without throwing', async () => {
    const createProvider = (): DecisionProvider => ({
      id: 'fake',
      decide: async () => {
        throw new TypedDecisionResponseError('Decision server returned HTTP 401', false, 401);
      },
    });

    const [probe] = await probeDecisionSites({
      configs: mapOf(config({ site: 'exam-grading' })),
      createProvider,
    });

    expect(probe).toMatchObject({
      site: 'exam-grading',
      status: 'error',
      detail: 'Decision server returned HTTP 401',
    });
  });

  it('does not spend a model call to probe a chat site', async () => {
    const createProvider = vi.fn();

    const [probe] = await probeDecisionSites({
      configs: mapOf(config({ site: 'quiz-grade', provider: 'chat', model: 'ollama:qwen3:4b' })),
      createProvider,
    });

    expect(probe).toMatchObject({ site: 'quiz-grade', provider: 'chat', status: 'configured' });
    expect(createProvider).not.toHaveBeenCalled();
  });

  it('preserves config order and writes no agreement telemetry', async () => {
    const probes = await probeDecisionSites({
      configs: mapOf(
        config({ site: 'quiz-verify' }),
        config({ site: 'exam-grading' }),
        config({ site: 'quiz-grade', provider: 'chat', model: 'ollama:qwen3:4b' }),
      ),
      createProvider: () => ({ id: 'fake', decide: async () => result() }),
    });

    expect(probes.map((probe) => probe.site)).toEqual([
      'quiz-verify',
      'exam-grading',
      'quiz-grade',
    ]);
    expect(readDecisionTelemetry()).toEqual([]);
  });
});
