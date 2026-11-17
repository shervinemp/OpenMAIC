import { beforeEach, describe, expect, it } from 'vitest';

import {
  mergeDecisionTelemetry,
  readDecisionTelemetry,
  readShadowAgreement,
  recordDecisionEvent,
  resetDecisionTelemetryForTests,
  snapshotDecisionTelemetry,
} from '@/lib/decision/telemetry';

beforeEach(() => {
  resetDecisionTelemetryForTests();
});

describe('decision telemetry', () => {
  it('counts events by site, provider, mode, and outcome', () => {
    recordDecisionEvent({
      site: 'quiz-grade',
      provider: 'laya',
      mode: 'triage',
      outcome: 'decision',
    });
    recordDecisionEvent({
      site: 'quiz-grade',
      provider: 'laya',
      mode: 'triage',
      outcome: 'decision',
    });
    recordDecisionEvent({
      site: 'quiz-grade',
      provider: 'laya',
      mode: 'triage',
      outcome: 'abstain',
    });

    expect(readDecisionTelemetry()).toEqual([
      { key: 'quiz-grade|laya|triage|abstain', count: 1 },
      { key: 'quiz-grade|laya|triage|decision', count: 2 },
    ]);
  });

  it('reports shadow agreement as a rate over comparable pairs only', () => {
    for (const outcome of ['shadow-agree', 'shadow-agree', 'shadow-disagree'] as const) {
      recordDecisionEvent({ site: 'exam-grading', provider: 'laya', mode: 'shadow', outcome });
    }
    recordDecisionEvent({
      site: 'exam-grading',
      provider: 'laya',
      mode: 'shadow',
      outcome: 'shadow-skip',
    });

    expect(readShadowAgreement()).toEqual([
      {
        site: 'exam-grading',
        provider: 'laya',
        agree: 2,
        disagree: 1,
        skipped: 1,
        decided: 3,
        agreementRate: 2 / 3,
      },
    ]);
  });

  it('reports a null rate when every shadow comparison was skipped', () => {
    recordDecisionEvent({
      site: 'quiz-grade',
      provider: 'chat:ollama:qwen3:4b',
      mode: 'shadow',
      outcome: 'shadow-skip',
    });

    const [row] = readShadowAgreement();
    expect(row).toMatchObject({ decided: 0, agreementRate: null, skipped: 1 });
  });

  it('merges a persisted snapshot and recomputes the rate from raw counts', () => {
    recordDecisionEvent({
      site: 'exam-grading',
      provider: 'laya',
      mode: 'shadow',
      outcome: 'shadow-agree',
    });

    mergeDecisionTelemetry({
      counters: [{ key: 'exam-grading|laya|shadow|shadow-agree', count: 2 }, { key: 'not a row' }],
      shadow: [
        {
          site: 'exam-grading',
          provider: 'laya',
          agree: 3,
          disagree: 1,
          skipped: 2,
          // A stale rate in the file must not override the summed counts.
          agreementRate: 0.01,
        },
      ],
    });

    expect(readDecisionTelemetry()).toEqual([
      { key: 'exam-grading|laya|shadow|shadow-agree', count: 3 },
    ]);
    expect(readShadowAgreement()[0]).toMatchObject({
      agree: 4,
      disagree: 1,
      skipped: 2,
      decided: 5,
      agreementRate: 4 / 5,
    });
  });

  it('ignores a malformed snapshot without clearing live counters', () => {
    recordDecisionEvent({
      site: 'quiz-verify',
      provider: 'laya',
      mode: 'replace',
      outcome: 'decision',
    });

    mergeDecisionTelemetry(null);
    mergeDecisionTelemetry({ counters: 'not-an-array', shadow: [{ site: 3 }] });

    expect(readDecisionTelemetry()).toHaveLength(1);
    expect(snapshotDecisionTelemetry().shadow).toEqual([]);
  });
});
