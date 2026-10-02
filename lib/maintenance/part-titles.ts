/**
 * Titles of the parts of a split slide.
 *
 * A split slide's parts are "<title>", "<title> (part 2)", "<title> (part 3)"
 * in play order. Splitting a part again, or removing one, left families reading
 * "<title> (part 6) (part 2)", numbered with gaps, or starting at "(part 2)"
 * because the first part was gone. The lesson list shows these titles, so they
 * are renumbered by position: the first part carries the bare title, the rest
 * count up from 2.
 *
 * Titles change on the scene, its flat outline and its blueprint entries (the
 * lesson's and the unit's copies); nothing else is touched.
 */

interface SceneShape {
  id: string;
  type?: string;
  title?: unknown;
  order?: unknown;
  outlineId?: unknown;
  [key: string]: unknown;
}

export interface PartTitleDocument {
  scenes: SceneShape[];
  outline?: {
    outlines?: Array<{ id?: unknown; title?: unknown }>;
    blueprint?: {
      lessons?: Array<{ outlines?: Array<{ id?: unknown; title?: unknown }> }>;
      units?: Array<{ lessons?: Array<{ outlines?: Array<{ id?: unknown; title?: unknown }> }> }>;
    };
  };
}

const PART_SUFFIX = /\s*\(part \d+\)\s*$/;
const FAMILY_SUFFIX = /(?:__p\d+(?:-[a-z0-9]+)?)+$/i;

function bareTitle(title: string): string {
  let result = title;
  while (PART_SUFFIX.test(result)) result = result.replace(PART_SUFFIX, '');
  return result.trim();
}

/** Returns how many scene titles changed. */
export function normalizePartTitles(document: PartTitleDocument): number {
  const families = new Map<string, SceneShape[]>();
  for (const scene of document.scenes) {
    if (scene.type !== 'slide' || typeof scene.title !== 'string') continue;
    const key = scene.id.replace(FAMILY_SUFFIX, '');
    const members = families.get(key);
    if (members) members.push(scene);
    else families.set(key, [scene]);
  }

  const renamed = new Map<string, string>(); // outline id -> new title
  let changed = 0;
  for (const members of families.values()) {
    const inOrder = [...members].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
    const isSplit = inOrder.length > 1 || inOrder.some((scene) => /__p\d+/.test(scene.id));
    if (!isSplit) continue;
    const base = bareTitle(String(inOrder[0]!.title));
    inOrder.forEach((scene, index) => {
      const next = index === 0 ? base : `${base} (part ${index + 1})`;
      if (scene.title !== next) {
        scene.title = next;
        changed += 1;
      }
      if (typeof scene.outlineId === 'string') renamed.set(scene.outlineId, next);
    });
  }
  if (renamed.size === 0) return changed;

  const retitle = (entries: Array<{ id?: unknown; title?: unknown }> | undefined): void => {
    for (const entry of entries ?? []) {
      const title = typeof entry.id === 'string' ? renamed.get(entry.id) : undefined;
      if (title !== undefined && entry.title !== title) entry.title = title;
    }
  };
  const outline = document.outline;
  retitle(outline?.outlines);
  for (const lesson of outline?.blueprint?.lessons ?? []) retitle(lesson.outlines);
  for (const unit of outline?.blueprint?.units ?? []) {
    for (const lesson of unit.lessons ?? []) retitle(lesson.outlines);
  }
  return changed;
}
