import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  describeSceneFailure,
  recordSceneFailure,
  resetSceneFailureLedgerForTests,
  snapshotSceneFailures,
  takeSceneFailure,
} from '@/lib/server/scene-failure-ledger';

const record = (overrides: Partial<Parameters<typeof recordSceneFailure>[0]> = {}) => ({
  code: 'invalid-model-output' as const,
  outlineId: 'outline-1',
  outlineTitle: 'Test Scene',
  sceneType: 'interactive',
  at: Date.now(),
  ...overrides,
});

beforeEach(() => {
  resetSceneFailureLedgerForTests();
});

afterEach(() => {
  resetSceneFailureLedgerForTests();
});

describe('scene failure ledger', () => {
  test('take-once read removes the record', () => {
    recordSceneFailure(record());
    expect(takeSceneFailure('outline-1')).toMatchObject({ code: 'invalid-model-output' });
    expect(takeSceneFailure('outline-1')).toBeUndefined();
  });

  test('freshest record per outline wins', () => {
    recordSceneFailure(record({ at: 1 }));
    recordSceneFailure(record({ code: 'prompt-unavailable', at: 2 }));
    expect(takeSceneFailure('outline-1')?.code).toBe('prompt-unavailable');
  });

  test('snapshot is newest-first and non-consuming', () => {
    recordSceneFailure(record({ outlineId: 'a', at: 1 }));
    recordSceneFailure(record({ outlineId: 'b', at: 2 }));
    expect(snapshotSceneFailures().map((o) => o.outlineId)).toEqual(['b', 'a']);
    expect(snapshotSceneFailures()).toHaveLength(2);
  });

  test('capacity ring drops the oldest outline, never the newest', () => {
    for (let i = 0; i < 300; i++) {
      recordSceneFailure(record({ outlineId: `outline-${i}`, at: i }));
    }
    expect(takeSceneFailure('outline-0')).toBeUndefined();
    expect(takeSceneFailure('outline-5')).toBeUndefined();
    expect(takeSceneFailure('outline-299')).toBeDefined();
    expect(snapshotSceneFailures()).toHaveLength(255);
  });

  test('describeSceneFailure maps codes and formats findings', () => {
    expect(describeSceneFailure(undefined)).toBeUndefined();
    expect(describeSceneFailure(record())).toContain('could not be parsed');
    expect(describeSceneFailure(record({ findings: ['slide has 1 substantive element'] }))).toBe(
      'the model output could not be parsed into the scene schema — findings: slide has 1 substantive element',
    );
  });
});
