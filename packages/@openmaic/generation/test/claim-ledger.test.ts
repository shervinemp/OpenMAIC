import { describe, expect, it } from 'vitest';

import { checkClaimLedger, repairClaimLedger } from '../src/claim-ledger.js';
import type { SceneOutline } from '../src/outline-types.js';

function outline(keyPoints: string[]): SceneOutline {
  return {
    id: 'scene_claims',
    type: 'slide',
    title: 'Water on Earth',
    description: 'Where water is stored',
    keyPoints,
  } as unknown as SceneOutline;
}

function slide(text: string): unknown {
  return {
    type: 'slide',
    canvas: {
      elements: [
        { id: 't1', type: 'text', left: 0, top: 0, width: 100, height: 20, content: text },
      ],
    },
  };
}

describe('checkClaimLedger', () => {
  it('flags a strictly qualified outline claim against an exact figure in the scene', () => {
    const issues = checkClaimLedger(
      outline(['Liquid fresh water is under 1% of all water.']),
      slide('Liquid fresh water is 1% of all water.'),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('qualifier-conflict');
    expect(issues[0].message).toContain('exactly 1%');
  });

  it('accepts neutral wording that matches the figure shown', () => {
    expect(
      checkClaimLedger(
        outline(['Liquid fresh water is under 1% of all water.']),
        slide('Liquid fresh water is about 1% of all water.'),
      ),
    ).toEqual([]);
  });

  it('flags a promised approximate ratio that disagrees with the computed one', () => {
    const issues = checkClaimLedger(
      outline(['The rate is nearly 6x higher at 35 C than at 10 C.']),
      slide('Computed ratio: 5.2x.'),
    );
    expect(issues.map((issue) => issue.code)).toContain('qualifier-conflict');
    expect(issues[0].message).toContain('5.2x');
  });

  it('flags an outline premise that the scene says stays constant', () => {
    const issues = checkClaimLedger(
      outline(['Paving raises S to 30 mm in the catchment model.']),
      slide('Paving does not change the result: S stays at 30 mm.'),
    );
    expect(issues.map((issue) => issue.code)).toContain('premise-conflict');
  });

  it('ignores layout and authoring fields when collecting learner text', () => {
    expect(
      checkClaimLedger(outline(['Liquid fresh water is under 1%.']), {
        type: 'slide',
        referenceFiles: [{ content: 'under 1%' }],
        canvas: { elements: [{ width: 1, top: 1, color: '1%' }] },
      }),
    ).toEqual([]);
  });
});

describe('repairClaimLedger', () => {
  it('rewrites only the contradictory qualifier phrase, using the figure in the scene', () => {
    const target = outline(['Liquid fresh water is under 1% of all water.']);
    const content = slide('Liquid fresh water is under 1% of all water. The chart shows 1%.');
    const issues = checkClaimLedger(target, content);
    expect(issues.length).toBeGreaterThan(0);

    const repaired = repairClaimLedger(content, issues);
    expect(repaired.repaired).toBe(1);
    expect(JSON.stringify(repaired.content)).toContain('about 1%');
    expect(JSON.stringify(repaired.content)).not.toContain('under 1%');
    expect(checkClaimLedger(target, repaired.content)).toEqual([]);
  });

  it('does nothing for semantic findings', () => {
    const content = slide('An unsupported claim.');
    const result = repairClaimLedger(content, [
      { code: 'unsupported-claim', message: 'This is not supported.' },
    ]);
    expect(result.repaired).toBe(0);
    expect(result.content).toBe(content);
  });
});
