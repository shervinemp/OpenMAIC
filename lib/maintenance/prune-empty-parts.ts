/**
 * Delete-only remediation for the empty-split-leftover class.
 *
 * The old splitter could leave its FIRST chunk with an empty canvas while
 * every row went to the later parts. The empty part has no validator errors
 * (nothing occludes nothing), so neither the deterministic pass nor the split
 * terminal can cure it — it simply parks as `layout: failed`, hidden from the
 * lesson list, forever.
 *
 * The prune only fires when all of the following hold, so a bit of genuinely
 * empty authoring can never be lost:
 *   - the scene is a slide with ZERO canvas elements;
 *   - a sibling sharing its base title (the "…(part N)" stem stripped) has at
 *     least one canvas element — the content exists elsewhere;
 * then the scene, its outline entry (flat + blueprint lesson + blueprint
 * unit), and its lesson-group job are removed together.
 *
 * "Empty canvas" is not "empty scene". The old splitter left the narration of a
 * whole lesson on that first, element-less chunk, and a prune that only counted
 * elements deleted it: 32 scenes and 272 narration lines (audio already
 * rendered) went with them. Narration is content, so before a scene goes its
 * actions are carried onto the surviving siblings, placed by what each line is
 * about (see narration-align), in front of what they already play.
 */

import { alignActionsToParts, slideTextOf } from './narration-align';

export interface EmptyPartPrunePlan {
  sceneIds: string[];
  outlineIds: string[];
}

export interface EmptyPartPruneResult {
  removedSceneIds: string[];
  removedOutlineIds: string[];
  /** Actions carried from a removed scene onto its siblings. */
  carriedActions: number;
}

export interface PruneDocumentShape {
  scenes: Array<Record<string, unknown>>;
  outline: {
    outlines?: Array<Record<string, unknown>>;
    lessonGroups?: Array<{ lessonId?: string; jobs?: Array<Record<string, unknown>> }>;
    blueprint?: {
      lessons?: Array<Record<string, unknown>>;
      units?: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const PART_SUFFIX = /\s*\(part \d+\)\s*$/;

function baseTitle(title: string): string {
  return title.replace(PART_SUFFIX, '').trim();
}

function elementCount(scene: Record<string, unknown>): number {
  const content = scene.content as { type?: string; canvas?: { elements?: unknown[] } } | undefined;
  if (!content || content.type !== 'slide') return 0;
  return Array.isArray(content.canvas?.elements) ? content.canvas!.elements!.length : 0;
}

/** Pure scan: which scenes are proven-redundant empty slide parts. */
export function findEmptyPartPrune(document: PruneDocumentShape): EmptyPartPrunePlan {
  const materializedByBase = new Map<string, number>();
  for (const scene of document.scenes) {
    if (scene.type !== 'slide') continue;
    if (elementCount(scene) === 0) continue;
    const key = baseTitle(String(scene.title ?? ''));
    materializedByBase.set(key, (materializedByBase.get(key) ?? 0) + 1);
  }

  const sceneIds: string[] = [];
  const outlineIds: string[] = [];
  for (const scene of document.scenes) {
    if (scene.type !== 'slide') continue;
    if (elementCount(scene) !== 0) continue;
    const outlineId = scene.outlineId;
    if (typeof outlineId !== 'string' || outlineId.length === 0) continue;
    const key = baseTitle(String(scene.title ?? ''));
    if ((materializedByBase.get(key) ?? 0) === 0) continue;
    sceneIds.push(String(scene.id));
    outlineIds.push(outlineId);
  }
  return { sceneIds, outlineIds };
}

/**
 * Apply a plan in memory. The caller persists with ONE `saveDocument`, so the
 * deck-completeness invariant never gaps mid-flight. Returns what was removed.
 */
export function applyEmptyPartPrune(
  document: PruneDocumentShape,
  plan: EmptyPartPrunePlan,
): EmptyPartPruneResult {
  const sceneSet = new Set(plan.sceneIds);
  const outlineSet = new Set(plan.outlineIds);

  const carriedActions = carryNarrationToSiblings(document, sceneSet);
  document.scenes = document.scenes.filter((scene) => !sceneSet.has(String(scene.id)));

  const outline = document.outline;
  if (Array.isArray(outline.outlines)) {
    outline.outlines = outline.outlines.filter(
      (entry) => !outlineSet.has(String((entry as { id?: string }).id)),
    );
  }
  for (const group of outline.lessonGroups ?? []) {
    if (!Array.isArray(group.jobs)) continue;
    group.jobs = group.jobs.filter((job) => !outlineSet.has(String(job.outlineId)));
  }
  const stripBlueprintOutlines = (lessons: Array<Record<string, unknown>> | undefined): void => {
    if (!Array.isArray(lessons)) return;
    for (const lesson of lessons) {
      const outlines = (lesson as { outlines?: Array<Record<string, unknown>> }).outlines;
      if (!Array.isArray(outlines)) continue;
      (lesson as { outlines: Array<Record<string, unknown>> }).outlines = outlines.filter(
        (entry) => !outlineSet.has(String((entry as { id?: string }).id)),
      );
    }
  };
  const blueprint = outline.blueprint;
  if (blueprint) {
    stripBlueprintOutlines(blueprint.lessons);
    for (const unit of blueprint.units ?? []) {
      stripBlueprintOutlines((unit as { lessons?: Array<Record<string, unknown>> }).lessons);
    }
  }

  return {
    removedSceneIds: plan.sceneIds,
    removedOutlineIds: plan.outlineIds,
    carriedActions,
  };
}

/**
 * Move the actions of every scene about to be removed onto the surviving slide
 * siblings that share its base title. A sibling is a part that keeps its
 * canvas; with one sibling everything lands there, with several the lines are
 * placed in order by overlap with each part's text. Returns how many actions
 * moved.
 */
function carryNarrationToSiblings(document: PruneDocumentShape, removed: Set<string>): number {
  let carried = 0;
  for (const scene of document.scenes) {
    if (!removed.has(String(scene.id))) continue;
    const actions = Array.isArray(scene.actions)
      ? (scene.actions as Array<Record<string, unknown>>)
      : [];
    if (actions.length === 0) continue;
    const key = baseTitle(String(scene.title ?? ''));
    const siblings = document.scenes
      .filter(
        (candidate) =>
          candidate.type === 'slide' &&
          !removed.has(String(candidate.id)) &&
          elementCount(candidate) > 0 &&
          baseTitle(String(candidate.title ?? '')) === key,
      )
      .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
    if (siblings.length === 0) continue;
    const placement = alignActionsToParts(
      actions as Array<{ type: string; text?: string }>,
      siblings.map(slideTextOf),
    );
    siblings.forEach((sibling, index) => {
      const mine = actions.filter((_, position) => placement[position] === index);
      if (mine.length === 0) return;
      const existing = Array.isArray(sibling.actions) ? (sibling.actions as unknown[]) : [];
      sibling.actions = [...mine, ...existing];
      carried += mine.length;
    });
  }
  return carried;
}
