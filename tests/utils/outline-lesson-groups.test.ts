import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@/lib/types/generation';
import {
  groupOutlinesByLesson,
  shouldGroupOutlines,
} from '@/lib/utils/outline-lesson-groups';

const outline = (order: number, lessonId?: string): SceneOutline =>
  ({
    id: `o${order}`,
    order,
    title: `Scene ${order}`,
    description: '',
    keyPoints: [],
    type: 'slide',
    ...(lessonId ? { lessonId } : {}),
  }) as SceneOutline;

describe('groupOutlinesByLesson', () => {
  it('groups by lesson while preserving global scene order', () => {
    const groups = groupOutlinesByLesson([
      outline(1, 'lesson_1'),
      outline(2, 'lesson_1'),
      outline(3, 'lesson_2'),
      outline(4, 'lesson_2'),
    ]);
    expect(groups.map((g) => [g.key, g.label])).toEqual([
      ['lesson_1', 'Lesson 1'],
      ['lesson_2', 'Lesson 2'],
    ]);
    expect(groups[0].outlines.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(groups[0].indices).toEqual([0, 1]);
    expect(groups[1].indices).toEqual([2, 3]);
  });

  it('keeps global indices correct when lessons are interleaved', () => {
    const groups = groupOutlinesByLesson([
      outline(1, 'lesson_1'),
      outline(2, 'lesson_2'),
      outline(3, 'lesson_1'),
    ]);
    expect(groups[0].indices).toEqual([0, 2]);
    expect(groups[1].indices).toEqual([1]);
  });

  it('puts unassigned outlines in a single fallback group', () => {
    const groups = groupOutlinesByLesson([outline(1), outline(2, 'lesson_1'), outline(3)]);
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe('__unassigned__');
    expect(groups[0].label).toBe('Scenes');
    expect(groups[0].outlines.map((o) => o.id)).toEqual(['o1', 'o3']);
  });

  it('returns an empty list for no outlines', () => {
    expect(groupOutlinesByLesson([])).toEqual([]);
  });
});

describe('shouldGroupOutlines', () => {
  it('stays flat for small or single-lesson decks', () => {
    const small = Array.from({ length: 20 }, (_, i) => outline(i + 1, 'lesson_1'));
    expect(shouldGroupOutlines(small, groupOutlinesByLesson(small))).toBe(false);

    const singleLesson = Array.from({ length: 600 }, (_, i) => outline(i + 1, 'lesson_1'));
    expect(shouldGroupOutlines(singleLesson, groupOutlinesByLesson(singleLesson))).toBe(false);
  });

  it('enables grouping for a large multi-lesson deck', () => {
    const semester = Array.from({ length: 600 }, (_, i) =>
      outline(i + 1, `lesson_${Math.floor(i / 13) + 1}`),
    );
    const groups = groupOutlinesByLesson(semester);
    expect(groups).toHaveLength(47);
    expect(shouldGroupOutlines(semester, groups)).toBe(true);
  });
});
