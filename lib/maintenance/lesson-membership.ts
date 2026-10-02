/**
 * Put every outline back inside its lesson.
 *
 * The blueprint is the course's table of contents: units hold lessons, lessons
 * hold outlines, and the lesson list shows a scene under the lesson its outline
 * belongs to. The layout splitter turns one overfull slide into several parts
 * and records the new outlines in the flat outline list and in the lesson's job
 * group, but not in the blueprint, so every part fell out of its lesson into
 * the "Ungrouped scenes" section: on a course of a thousand split slides, most
 * of the course.
 *
 * Each outline missing from the blueprint is placed in the lesson it names
 * (`lessonId`), or failing that the lesson of the closest outline before it, and
 * right after the closest earlier outline of that lesson, so parts sit in play
 * order beside the slide they came from. The unit's copy of the lesson is kept
 * in step, as the prune keeps it.
 */

interface OutlineEntry {
  id?: unknown;
  order?: unknown;
  lessonId?: unknown;
  [key: string]: unknown;
}

interface LessonShape {
  outlines?: OutlineEntry[];
  [key: string]: unknown;
}

export interface OutlineRecordShape {
  outlines?: OutlineEntry[];
  blueprint?: {
    lessons?: LessonShape[];
    units?: Array<{ lessons?: LessonShape[] }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function lessonIndexOf(entry: OutlineEntry, lessonCount: number): number | null {
  if (typeof entry.lessonId !== 'string') return null;
  const match = /^lesson_(\d+)$/.exec(entry.lessonId);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return index >= 0 && index < lessonCount ? index : null;
}

/** The unit-side copy of the blueprint's lesson at this global position. */
function unitLessonAt(record: OutlineRecordShape, index: number): LessonShape | null {
  let cursor = 0;
  for (const unit of record.blueprint?.units ?? []) {
    for (const lesson of unit.lessons ?? []) {
      if (cursor === index) return lesson;
      cursor += 1;
    }
  }
  return null;
}

function insertAfter(
  lesson: LessonShape,
  entry: OutlineEntry,
  afterId: unknown,
  copy: (entry: OutlineEntry) => OutlineEntry,
): void {
  if (!Array.isArray(lesson.outlines)) lesson.outlines = [];
  if (lesson.outlines.some((candidate) => candidate.id === entry.id)) return;
  const position = lesson.outlines.findIndex((candidate) => candidate.id === afterId);
  lesson.outlines.splice(position >= 0 ? position + 1 : 0, 0, copy(entry));
}

/** Returns how many outlines were put into a lesson. */
export function registerOrphanOutlines(record: OutlineRecordShape): number {
  const lessons = record.blueprint?.lessons;
  const flat = record.outlines;
  if (!Array.isArray(lessons) || lessons.length === 0 || !Array.isArray(flat)) return 0;

  const lessonOf = new Map<unknown, number>();
  lessons.forEach((lesson, index) =>
    (lesson.outlines ?? []).forEach((entry) => lessonOf.set(entry.id, index)),
  );
  const ordered = [...flat].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));

  let registered = 0;
  let previous: OutlineEntry | null = null;
  for (const entry of ordered) {
    if (!lessonOf.has(entry.id)) {
      const index =
        lessonIndexOf(entry, lessons.length) ?? (previous ? lessonOf.get(previous.id) : undefined);
      if (index !== undefined && index !== null) {
        // The closest earlier outline that already sits in this lesson.
        let anchor: OutlineEntry | null = null;
        for (const earlier of ordered) {
          if (earlier === entry) break;
          if (lessonOf.get(earlier.id) === index) anchor = earlier;
        }
        const copy = (source: OutlineEntry): OutlineEntry => ({ ...source });
        insertAfter(lessons[index]!, entry, anchor?.id, copy);
        const unitLesson = unitLessonAt(record, index);
        if (unitLesson) insertAfter(unitLesson, entry, anchor?.id, copy);
        lessonOf.set(entry.id, index);
        if (entry.lessonId === undefined) entry.lessonId = `lesson_${index + 1}`;
        registered += 1;
      }
    }
    previous = entry;
  }
  return registered;
}
