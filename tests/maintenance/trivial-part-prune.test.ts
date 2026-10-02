import { describe, expect, it } from 'vitest';

import {
  findTrivialPartPrune,
  mergePrunePlans,
  type PruneDocumentShape,
} from '@/lib/maintenance/prune-empty-parts';

const part = (
  id: string,
  order: number,
  elements: Array<Record<string, unknown>>,
  actions: unknown[] = [],
): Record<string, unknown> => ({
  id,
  outlineId: `o-${id}`,
  type: 'slide',
  title: id,
  order,
  content: { type: 'slide', canvas: { viewportSize: 1000, viewportRatio: 0.5625, elements } },
  actions,
});

const text = (words: number) => ({
  id: `t${words}`,
  type: 'text',
  content: `<p>${Array.from({ length: words }, (_, i) => `w${i}`).join(' ')}</p>`,
});

const doc = (extra: Array<Record<string, unknown>>): PruneDocumentShape => ({
  scenes: [part('fam', 1, [text(90)]), ...extra],
  outline: { outlines: [] },
});

describe('findTrivialPartPrune', () => {
  it('finds a stranded heading, and an empty frame, beside a part that has the content', () => {
    const plan = findTrivialPartPrune(
      doc([part('fam__p2', 2, [text(3)]), part('fam__p3', 3, [{ id: 's', type: 'shape' }])]),
    );
    expect(plan.sceneIds).toEqual(['fam__p2', 'fam__p3']);
    expect(plan.outlineIds).toEqual(['o-fam__p2', 'o-fam__p3']);
  });

  it('keeps anything that plays, draws, or teaches', () => {
    const plan = findTrivialPartPrune(
      doc([
        part('fam__p2', 2, [text(3)], [{ id: 'a', type: 'speech', text: 'Spoken.' }]),
        part('fam__p3', 3, [text(3), { id: 'l', type: 'line' }]),
        part('fam__p4', 4, [{ id: 'tb', type: 'table' }]),
        part('fam__p5', 5, [text(12)]),
      ]),
    );
    expect(plan.sceneIds).toEqual([]);
  });

  it('never removes a slide that is not a split part, or the only thing a family has', () => {
    expect(
      findTrivialPartPrune({ scenes: [part('lone', 1, [text(2)])], outline: {} }).sceneIds,
    ).toEqual([]);
    const allTrivial: PruneDocumentShape = {
      scenes: [part('f__p2', 1, [text(2)]), part('f__p3', 2, [text(2)])],
      outline: {},
    };
    expect(findTrivialPartPrune(allTrivial).sceneIds).toEqual([]);
  });

  it('merges with the empty-canvas plan without duplicates', () => {
    const merged = mergePrunePlans(
      { sceneIds: ['a', 'b'], outlineIds: ['oa', 'ob'] },
      { sceneIds: ['b', 'c'], outlineIds: ['ob', 'oc'] },
    );
    expect(merged).toEqual({ sceneIds: ['a', 'b', 'c'], outlineIds: ['oa', 'ob', 'oc'] });
  });
});
