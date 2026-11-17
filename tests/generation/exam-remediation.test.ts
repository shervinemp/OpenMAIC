import { describe, expect, test } from 'vitest';
import type { SceneOutline } from '@openmaic/generation';
import { attachExamRemediation } from '@openmaic/generation';

function outline(
  overrides: Partial<SceneOutline> & Pick<SceneOutline, 'id' | 'order'>,
): SceneOutline {
  return {
    type: 'slide',
    title: overrides.id,
    description: '',
    keyPoints: [],
    ...overrides,
  } as SceneOutline;
}

const outlines: SceneOutline[] = [
  outline({
    id: 'recursion-lesson',
    order: 2,
    title: 'Recursion and the call stack',
    keyPoints: ['A recursive function needs a base case'],
  }),
  outline({
    id: 'sql-lesson',
    order: 5,
    title: 'SQL joins',
    keyPoints: ['Join tables on a shared key'],
  }),
  // Assessments and activities are never remediation destinations.
  outline({
    id: 'quiz-outline',
    type: 'quiz',
    order: 6,
    title: 'Recursion quiz',
    keyPoints: ['recursion'],
  }),
];

describe('exam remediation links', () => {
  test('links an item to the teaching outline that covers its concepts', () => {
    const [question] = attachExamRemediation([{ id: 'mc1', concepts: ['recursion'] }], outlines);
    expect(question?.remediationOutlineId).toBe('recursion-lesson');

    const [sql] = attachExamRemediation([{ id: 'mc2', concepts: ['SQL joins'] }], outlines);
    expect(sql?.remediationOutlineId).toBe('sql-lesson');
  });

  test('requires a phrase or every token of one concept, not a partial coincidence', () => {
    const [partial] = attachExamRemediation([{ id: 'mc1', concepts: ['sql query'] }], outlines);
    expect(partial?.remediationOutlineId).toBeUndefined();

    const [unknown] = attachExamRemediation([{ id: 'mc2', concepts: ['binary tree'] }], outlines);
    expect(unknown?.remediationOutlineId).toBeUndefined();
  });

  test('clears the link for untagged items and never mutates the input', () => {
    const input = [{ id: 'mc1', concepts: ['recursion'] }, { id: 'mc2' }];
    const linked = attachExamRemediation(input, outlines);

    expect(linked[0]?.remediationOutlineId).toBe('recursion-lesson');
    expect(linked[1]?.remediationOutlineId).toBeUndefined();
    expect(input[0]).not.toHaveProperty('remediationOutlineId');
  });

  test('clears every link when the covered range has no teaching outline', () => {
    const assessments = outlines.filter((entry) => entry.type === 'quiz');
    const [question] = attachExamRemediation([{ id: 'mc1', concepts: ['recursion'] }], assessments);
    expect(question?.remediationOutlineId).toBeUndefined();
  });
});
