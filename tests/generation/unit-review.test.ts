import { describe, expect, test } from 'vitest';
import {
  buildUnitReviewSummary,
  summarizeUnitReviewFindings,
  validateUnitReviewVerdict,
} from '@/lib/generation/unit-review';
import type { SceneOutline, UnitBlueprint } from '@/lib/types/generation';

function makeUnit(): UnitBlueprint {
  return {
    title: 'Processes and Threads',
    objectives: ['Model process lifecycles', 'Compare scheduling policies'],
    durationMinutes: 30,
    sceneTarget: 3,
    lessons: [
      {
        title: 'Process abstraction',
        objectives: ['Define a process'],
        durationMinutes: 10,
        sceneTarget: 1,
        outlines: [],
      },
      {
        title: 'Scheduling',
        objectives: ['Evaluate policies'],
        durationMinutes: 10,
        sceneTarget: 2,
        outlines: [],
      },
    ],
  };
}

function makeOutlines(): SceneOutline[] {
  return [
    {
      id: 's1',
      type: 'slide',
      title: 'Process lifecycle states',
      description: 'The five states and the transitions between them.',
      keyPoints: ['ready', 'running', 'blocked'],
      order: 1,
    },
    {
      id: 's2',
      type: 'exercise',
      title: 'Scheduling worked example',
      description: 'Compute turnaround time for FCFS vs round robin.',
      keyPoints: ['FCFS', 'round robin'],
      order: 2,
    },
  ];
}

describe('buildUnitReviewSummary', () => {
  test('serializes unit objectives, lessons, and scene outlines', () => {
    const summary = buildUnitReviewSummary(makeUnit(), makeOutlines());
    expect(summary).toContain('Unit: Processes and Threads');
    expect(summary).toContain('Model process lifecycles');
    expect(summary).toContain('1. Process abstraction');
    expect(summary).toContain('[slide] Process lifecycle states');
    expect(summary).toContain('[exercise] Scheduling worked example');
  });

  test('caps the summary defensively', () => {
    const huge: SceneOutline[] = Array.from({ length: 600 }, (_, i) => ({
      id: `s${i}`,
      type: 'slide',
      title: `Scene ${i}`,
      description: 'A'.repeat(200),
      keyPoints: ['a', 'b', 'c'],
      order: i + 1,
    }));
    const summary = buildUnitReviewSummary(makeUnit(), huge);
    expect(summary.length).toBeLessThanOrEqual(12_000 + 20);
    expect(summary).toContain('(truncated)');
  });
});

describe('validateUnitReviewVerdict', () => {
  test('accepts an adequate verdict and strips stray findings', () => {
    const { verdict, errors } = validateUnitReviewVerdict({
      adequate: true,
      findings: ['leftover'],
    });
    expect(errors).toHaveLength(0);
    expect(verdict).toEqual({ adequate: true, findings: [] });
  });

  test('accepts an inadequate verdict with concrete findings', () => {
    const { verdict, errors } = validateUnitReviewVerdict({
      adequate: false,
      findings: ['Objective X is not taught by any scene'],
    });
    expect(errors).toHaveLength(0);
    expect(verdict?.adequate).toBe(false);
    expect(verdict?.findings).toHaveLength(1);
  });

  test('rejects a false verdict without findings', () => {
    const { verdict, errors } = validateUnitReviewVerdict({ adequate: false, findings: [] });
    expect(verdict).toBeNull();
    expect(errors.some((e) => e.includes('at least one concrete finding'))).toBe(true);
  });

  test('rejects non-objects and missing fields', () => {
    expect(validateUnitReviewVerdict(null).verdict).toBeNull();
    expect(validateUnitReviewVerdict([]).verdict).toBeNull();
    const { verdict, errors } = validateUnitReviewVerdict({ adequate: 'yes', findings: [] });
    expect(verdict).toBeNull();
    expect(errors.some((e) => e.includes('"adequate" boolean'))).toBe(true);
  });
});

describe('summarizeUnitReviewFindings', () => {
  test('produces actionable corrective feedback', () => {
    const feedback = summarizeUnitReviewFindings({
      adequate: false,
      findings: ['Objective "Model process lifecycles" is not taught by any scene'],
    });
    expect(feedback).toContain('REJECTED');
    expect(feedback).toContain('Model process lifecycles');
    expect(feedback).toContain('Revise the unit outlines');
  });
});
