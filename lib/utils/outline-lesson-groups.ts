import type { SceneOutline } from '@/lib/types/generation';

export interface LessonOutlineGroup {
  key: string;
  label: string;
  outlines: SceneOutline[];
  /** Global indices into the original flat outlines array, in order. */
  indices: number[];
}

const UNASSIGNED_KEY = '__unassigned__';

function lessonLabel(lessonId: string): string {
  const match = lessonId.match(/^lesson[_-]?(\d+)$/i);
  return match ? `Lesson ${match[1]}` : lessonId.replace(/^lesson[_-]?/i, 'Lesson ');
}

/**
 * Group a flat, globally-ordered outline list by `lessonId`, preserving the
 * first-appearance order of both groups and their scenes. Outlines without a
 * lessonId join one fallback group, so legacy and single-unit decks still
 * render identically to the flat list.
 *
 * This is what makes a 600-scene semester review cheap: the UI renders 48
 * collapsed lesson headers instead of 600 scene rows, and only mounts the
 * ~12 rows of whichever lesson the user expands.
 */
export function groupOutlinesByLesson(outlines: readonly SceneOutline[]): LessonOutlineGroup[] {
  const groups: LessonOutlineGroup[] = [];
  const byKey = new Map<string, LessonOutlineGroup>();
  outlines.forEach((outline, index) => {
    const key = outline.lessonId || UNASSIGNED_KEY;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        label: key === UNASSIGNED_KEY ? 'Scenes' : lessonLabel(key),
        outlines: [],
        indices: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.outlines.push(outline);
    group.indices.push(index);
  });
  return groups;
}

/**
 * Grouping only pays off — and only reads naturally — for a large, genuinely
 * multi-lesson deck. Everything smaller keeps the existing flat editor, which
 * also preserves behaviour for all existing tests and single-unit courses.
 */
export function shouldGroupOutlines(
  outlines: readonly SceneOutline[],
  groups: readonly LessonOutlineGroup[],
  threshold = 40,
): boolean {
  return outlines.length > threshold && groups.length > 1;
}
