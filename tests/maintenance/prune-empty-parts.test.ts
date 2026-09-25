import { describe, expect, it } from 'vitest';

import {
  applyEmptyPartPrune,
  findEmptyPartPrune,
  type PruneDocumentShape,
} from '@/lib/maintenance/prune-empty-parts';

function slide(
  id: string,
  title: string,
  order: number,
  outlineId: string,
  elements: number,
): Record<string, unknown> {
  return {
    id,
    outlineId,
    stageId: 'stage-1',
    type: 'slide',
    title,
    order,
    content: {
      type: 'slide',
      canvas: {
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: Array.from({ length: elements }, (_, i) => ({ id: `${id}-el${i}`, type: 'text' })),
      },
    },
    actions: [],
  };
}

function makeDocument(): PruneDocumentShape {
  return {
    stage: { id: 'stage-1' },
    scenes: [
      slide('base-empty', 'Worked Problem: Joins', 0, 'o-base', 0),
      slide('base-part2', 'Worked Problem: Joins (part 2)', 1, 'o-p2', 3),
      slide('orphan-empty', 'A genuinely empty intro', 2, 'o-orphan', 0),
      slide('pair-empty-a', 'Twins', 3, 'o-twin-a', 0),
      slide('pair-empty-b', 'Twins', 4, 'o-twin-b', 0),
      { id: 'quiz-1', outlineId: 'o-quiz', type: 'quiz', title: 'Quiz', order: 5, content: { type: 'quiz', questions: [] } },
    ],
    outline: {
      outlines: [
        { id: 'o-base', order: 0, lessonId: 'l1', title: 'Worked Problem: Joins' },
        { id: 'o-p2', order: 1, lessonId: 'l1', title: 'Worked Problem: Joins (part 2)' },
        { id: 'o-orphan', order: 2, lessonId: 'l1', title: 'A genuinely empty intro' },
        { id: 'o-twin-a', order: 3, lessonId: 'l2', title: 'Twins' },
        { id: 'o-twin-b', order: 4, lessonId: 'l2', title: 'Twins' },
        { id: 'o-quiz', order: 5, lessonId: 'l2', title: 'Quiz' },
      ],
      lessonGroups: [
        { lessonId: 'l1', jobs: [{ outlineId: 'o-base', phases: {} }, { outlineId: 'o-p2', phases: {} }, { outlineId: 'o-orphan', phases: {} }] },
        { lessonId: 'l2', jobs: [{ outlineId: 'o-twin-a', phases: {} }, { outlineId: 'o-twin-b', phases: {} }, { outlineId: 'o-quiz', phases: {} }] },
      ],
      blueprint: {
        lessons: [
          { title: 'L1', outlines: [{ id: 'o-base' }, { id: 'o-p2' }, { id: 'o-orphan' }] },
          { title: 'L2', outlines: [{ id: 'o-twin-a' }, { id: 'o-twin-b' }, { id: 'o-quiz' }] },
        ],
        units: [
          {
            title: 'U1',
            lessons: [
              { title: 'L1', outlines: [{ id: 'o-base' }, { id: 'o-p2' }, { id: 'o-orphan' }] },
              { title: 'L2', outlines: [{ id: 'o-twin-a' }, { id: 'o-twin-b' }, { id: 'o-quiz' }] },
            ],
          },
        ],
      },
    },
  };
}

describe('prune-empty-parts', () => {
  it('prunes only the empty part with a materialized same-base sibling', () => {
    const document = makeDocument();
    const plan = findEmptyPartPrune(document);
    expect(plan.sceneIds).toEqual(['base-empty']);
    expect(plan.outlineIds).toEqual(['o-base']);
  });

  it('keeps empties without a materialized sibling (orphans and empty pairs)', () => {
    const document = makeDocument();
    const plan = findEmptyPartPrune(document);
    expect(plan.sceneIds).not.toContain('orphan-empty');
    expect(plan.sceneIds).not.toContain('pair-empty-a');
    expect(plan.sceneIds).not.toContain('pair-empty-b');
    // Quiz scenes are never candidates even when empty.
    expect(plan.sceneIds).not.toContain('quiz-1');
  });

  it('removes every reference together, leaving siblings untouched', () => {
    const document = makeDocument();
    const plan = findEmptyPartPrune(document);
    const result = applyEmptyPartPrune(document, plan);

    expect(result.removedSceneIds).toEqual(['base-empty']);
    expect(document.scenes.map((s) => s.id)).toEqual([
      'base-part2',
      'orphan-empty',
      'pair-empty-a',
      'pair-empty-b',
      'quiz-1',
    ]);
    expect((document.outline.outlines ?? []).map((o) => o.id)).not.toContain('o-base');
    expect(
      (document.outline.lessonGroups ?? []).flatMap((g) => (g.jobs ?? []).map((j) => j.outlineId)),
    ).not.toContain('o-base');
    const blueprint = document.outline.blueprint!;
    const lessonIds = (blueprint.lessons ?? []).flatMap((l) =>
      ((l as { outlines?: Array<{ id?: string }> }).outlines ?? []).map((o) => o.id),
    );
    expect(lessonIds).not.toContain('o-base');
    const unitIds = (blueprint.units ?? []).flatMap((u) =>
      ((u as { lessons?: Array<Record<string, unknown>> }).lessons ?? []).flatMap((l) =>
        ((l as { outlines?: Array<{ id?: string }> }).outlines ?? []).map((o) => o.id),
      ),
    );
    expect(unitIds).not.toContain('o-base');
    // Untouched references survive on both shapes.
    expect(lessonIds).toContain('o-p2');
    expect(unitIds).toContain('o-p2');
  });

  it('is a no-op on a document with no proven-redundant empties', () => {
    const document = makeDocument();
    document.scenes = document.scenes.filter((s) => s.id !== 'base-empty');
    const plan = findEmptyPartPrune(document);
    expect(plan.sceneIds).toEqual([]);
  });
});
