import { describe, expect, it } from 'vitest';

import type { ActivityCheckResult } from '@/lib/activity/checks';
import { evidenceFromActivityRun } from '@/lib/learning/from-activity';

const results: ActivityCheckResult[] = [
  { checkId: 'tests', status: 'passed', earned: 1, possible: 1 },
  { checkId: 'output', status: 'failed', earned: 0, possible: 1, message: 'no output' },
  { checkId: 'file', status: 'ungraded', earned: 0, possible: 1, message: 'missing' },
];

function records(overrides: Partial<Parameters<typeof evidenceFromActivityRun>[0]> = {}) {
  return evidenceFromActivityRun({
    learnerKey: 'learner-1',
    stageId: 'stage-1',
    sceneId: 'scene-1',
    attemptId: 'run-1',
    recordedAt: 1_234,
    concepts: ['Recursion', 'recursion.', 'quiz'],
    results,
    ...overrides,
  });
}

describe('activity evidence', () => {
  it('maps every check outcome without reinterpreting the evaluator', () => {
    const evidence = records();

    expect(evidence).toHaveLength(3);
    expect(evidence[0]).toMatchObject({
      id: 'stage-1:activity:scene-1:run-1:tests',
      itemId: 'tests',
      conceptIds: ['recursion'],
      source: 'activity',
      score: 1,
      outcome: 'graded',
      recordedAt: 1_234,
    });
    expect(evidence[1]).toMatchObject({ score: 0, outcome: 'graded' });
    expect(evidence[2]).toMatchObject({ score: 0, outcome: 'ungraded' });
  });

  it('leaves an untagged legacy lab untagged but still records the run', () => {
    const evidence = records({ concepts: undefined });
    expect(evidence).toHaveLength(3);
    expect(evidence.every((record) => record.conceptIds.length === 0)).toBe(true);
  });

  it('returns nothing for an empty run', () => {
    expect(records({ results: [] })).toEqual([]);
  });
});
