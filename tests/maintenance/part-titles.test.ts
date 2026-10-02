import { describe, expect, it } from 'vitest';

import { normalizePartTitles, type PartTitleDocument } from '@/lib/maintenance/part-titles';

const slide = (id: string, order: number, title: string, outlineId = `o-${id}`) => ({
  id,
  type: 'slide',
  order,
  title,
  outlineId,
});

describe('normalizePartTitles', () => {
  it('numbers a family by position: bare title first, then (part 2), (part 3)', () => {
    const doc: PartTitleDocument = {
      scenes: [
        slide('a', 1, 'Joins'),
        slide('a__p2', 2, 'Joins (part 2)'),
        slide('a__p4', 3, 'Joins (part 4)'),
      ],
    };
    expect(normalizePartTitles(doc)).toBe(1);
    expect(doc.scenes.map((s) => s.title)).toEqual(['Joins', 'Joins (part 2)', 'Joins (part 3)']);
  });

  it('untangles a part that was split again', () => {
    const doc: PartTitleDocument = {
      scenes: [
        slide('a', 1, 'CDC (part 1)'.replace(' (part 1)', '')),
        slide('a__p6', 2, 'CDC (part 6)'),
        slide('a__p6__p2', 3, 'CDC (part 6) (part 2)'),
      ],
    };
    normalizePartTitles(doc);
    expect(doc.scenes.map((s) => s.title)).toEqual(['CDC', 'CDC (part 2)', 'CDC (part 3)']);
  });

  it('starts at the bare title when the first part is gone', () => {
    const doc: PartTitleDocument = {
      scenes: [
        slide('a__p2', 1, 'Worked Problem (part 2)'),
        slide('a__p3', 2, 'Worked Problem (part 3)'),
      ],
    };
    normalizePartTitles(doc);
    expect(doc.scenes.map((s) => s.title)).toEqual(['Worked Problem', 'Worked Problem (part 2)']);
  });

  it('carries the new titles to the flat outline and both blueprint copies', () => {
    const doc: PartTitleDocument = {
      scenes: [slide('a', 1, 'Joins'), slide('a__p3', 2, 'Joins (part 3)')],
      outline: {
        outlines: [
          { id: 'o-a', title: 'Joins' },
          { id: 'o-a__p3', title: 'Joins (part 3)' },
        ],
        blueprint: {
          lessons: [{ outlines: [{ id: 'o-a__p3', title: 'Joins (part 3)' }] }],
          units: [{ lessons: [{ outlines: [{ id: 'o-a__p3', title: 'Joins (part 3)' }] }] }],
        },
      },
    };
    normalizePartTitles(doc);
    expect(doc.outline!.outlines![1]!.title).toBe('Joins (part 2)');
    expect(doc.outline!.blueprint!.lessons![0]!.outlines![0]!.title).toBe('Joins (part 2)');
    expect(doc.outline!.blueprint!.units![0]!.lessons![0]!.outlines![0]!.title).toBe(
      'Joins (part 2)',
    );
  });

  it('leaves slides that are not split, and a title that merely ends in (part N), alone', () => {
    const doc: PartTitleDocument = {
      scenes: [slide('solo', 1, 'Chapter (part 2)'), slide('other', 2, 'Intro')],
    };
    expect(normalizePartTitles(doc)).toBe(0);
    expect(doc.scenes[0]!.title).toBe('Chapter (part 2)');
  });

  it('is idempotent', () => {
    const doc: PartTitleDocument = {
      scenes: [slide('a', 1, 'Joins'), slide('a__p2', 2, 'Joins (part 2)')],
    };
    expect(normalizePartTitles(doc)).toBe(0);
  });
});
