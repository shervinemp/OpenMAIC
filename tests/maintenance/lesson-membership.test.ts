import { describe, expect, it } from 'vitest';

import {
  registerOrphanOutlines,
  type OutlineRecordShape,
} from '@/lib/maintenance/lesson-membership';

const o = (id: string, order: number, lessonId?: string) => ({
  id,
  order,
  title: id,
  ...(lessonId ? { lessonId } : {}),
});
const ids = (entries?: Array<{ id?: unknown }>) => (entries ?? []).map((e) => e.id);

function record(): OutlineRecordShape {
  return {
    // Flat list: two lessons, with parts of A (a__p2, a__p3) and B (b__p2) that the blueprint never heard of.
    outlines: [
      o('a', 1, 'lesson_1'),
      o('a__p2', 2, 'lesson_1'),
      o('a__p3', 3, 'lesson_1'),
      o('c', 4, 'lesson_1'),
      o('b', 5, 'lesson_2'),
      o('b__p2', 6, 'lesson_2'),
    ],
    blueprint: {
      lessons: [{ outlines: [o('a', 1), o('c', 4)] }, { outlines: [o('b', 5)] }],
      units: [
        { lessons: [{ outlines: [o('a', 1), o('c', 4)] }] },
        { lessons: [{ outlines: [o('b', 5)] }] },
      ],
    },
  };
}

describe('registerOrphanOutlines', () => {
  it('puts each part in its lesson, in play order, right after the slide it came from', () => {
    const doc = record();
    expect(registerOrphanOutlines(doc)).toBe(3);
    expect(ids(doc.blueprint!.lessons![0]!.outlines)).toEqual(['a', 'a__p2', 'a__p3', 'c']);
    expect(ids(doc.blueprint!.lessons![1]!.outlines)).toEqual(['b', 'b__p2']);
  });

  it('keeps the unit-side copy of each lesson in step', () => {
    const doc = record();
    registerOrphanOutlines(doc);
    expect(ids(doc.blueprint!.units![0]!.lessons![0]!.outlines)).toEqual([
      'a',
      'a__p2',
      'a__p3',
      'c',
    ]);
    expect(ids(doc.blueprint!.units![1]!.lessons![0]!.outlines)).toEqual(['b', 'b__p2']);
  });

  it('is idempotent', () => {
    const doc = record();
    registerOrphanOutlines(doc);
    expect(registerOrphanOutlines(doc)).toBe(0);
    expect(ids(doc.blueprint!.lessons![0]!.outlines)).toEqual(['a', 'a__p2', 'a__p3', 'c']);
  });

  it('falls back to the closest earlier outline when the part names no lesson', () => {
    const doc = record();
    for (const entry of doc.outlines!) delete entry.lessonId;
    expect(registerOrphanOutlines(doc)).toBe(3);
    expect(ids(doc.blueprint!.lessons![0]!.outlines)).toEqual(['a', 'a__p2', 'a__p3', 'c']);
    expect(ids(doc.blueprint!.lessons![1]!.outlines)).toEqual(['b', 'b__p2']);
  });

  it('copies the outline rather than sharing it, and records the lesson it joined', () => {
    const doc = record();
    for (const entry of doc.outlines!) delete entry.lessonId;
    registerOrphanOutlines(doc);
    const inLesson = doc.blueprint!.lessons![0]!.outlines!.find((e) => e.id === 'a__p2')!;
    const flat = doc.outlines!.find((e) => e.id === 'a__p2')!;
    expect(inLesson).not.toBe(flat);
    expect(flat.lessonId).toBe('lesson_1');
  });

  it('does nothing without a blueprint, and leaves a part with no lesson to find alone', () => {
    expect(registerOrphanOutlines({ outlines: [o('x', 1)] })).toBe(0);
    const doc: OutlineRecordShape = {
      outlines: [o('orphan-first', 1)],
      blueprint: { lessons: [{ outlines: [o('a', 2)] }] },
    };
    expect(registerOrphanOutlines(doc)).toBe(0);
  });
});
