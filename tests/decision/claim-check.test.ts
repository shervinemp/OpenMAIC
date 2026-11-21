import { describe, expect, it } from 'vitest';

import { buildClaimDecisionRequest } from '@/lib/decision/sites/claim-check';
import type { ClaimReviewContext } from '@openmaic/generation';

const context: ClaimReviewContext = {
  outline: {
    id: 'scene_1',
    type: 'slide',
    title: 'Fresh water',
    description: 'Where fresh water is stored',
    keyPoints: ['Liquid fresh water is under 1%'],
  } as never,
  content: {
    type: 'slide',
    canvas: {
      elements: [{ id: 't1', type: 'text', content: 'Liquid fresh water is 1%.' }],
    },
  },
  findings: [{ code: 'qualifier-conflict', message: 'under 1% vs 1%' }],
};

describe('claim-check decision site', () => {
  it('builds a single typed question from the outline and learner-facing content', () => {
    const request = buildClaimDecisionRequest(context);

    expect(request.state).toContain('Liquid fresh water is under 1%');
    expect(request.state).toContain('Liquid fresh water is 1%.');
    expect(request.questions).toHaveLength(1);
    expect(request.questions[0].kind).toBe('choice');
    expect(request.questions[0].options.map((option) => option.value)).toEqual(['yes', 'no']);
  });

  it('does not leak authoring ids or media references into the typed state', () => {
    const request = buildClaimDecisionRequest({
      ...context,
      content: {
        ...(context.content as object),
        referenceFiles: [{ content: 'SECRET ANSWER' }],
      },
    });
    expect(request.state).not.toContain('SECRET ANSWER');
    expect(request.state).not.toContain('t1');
  });
});
