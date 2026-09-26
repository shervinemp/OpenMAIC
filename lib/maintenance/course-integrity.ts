/**
 * Load-time integrity pass over a stored course (deterministic, zero tokens).
 *
 * Several guards run only while a scene is generated or written — dead
 * spotlight anchors are stripped at commit, the quiz option contract and the
 * widget script check gate new output — so a course stored before a guard
 * existed, or edited since, never meets it again. This pass applies the same
 * cures to what is stored, and reports what it cannot cure for free:
 *
 *  - split narration: a split family whose later parts are empty and silent
 *    (no anchor let the splitter place the lines) gets its narration
 *    distributed across its parts by what each line is about;
 *  - dead spotlight anchors: stripped, as at commit;
 *  - duplicate element ids: renamed, so the semantics gate can pass;
 *  - quiz answer keys: rewritten to option values where the intent is certain
 *    (truncated or joined-label keys grade a correct choice as wrong);
 *  - broken widgets: reported — regenerating one costs tokens, so it becomes a
 *    retry card rather than a silent fix;
 *  - spotlights: a slide whose narration never points at anything gets one
 *    where a line is unmistakably about one element (see auto-spotlight;
 *    opt-out with `autoSpotlight: false`).
 *
 * Pure: scenes are never mutated; changes come back as patches.
 */

import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import { findWidgetScriptFailure } from '@/lib/interactive/widget-script-check';
import { healedAnswerKey } from '@/lib/quiz/answer-key-heal';
import { dedupeElementIds, stripDeadActionAnchors } from './content-audit';
import { withAutoSpotlights } from './auto-spotlight';
import { alignActionsToParts, plainText } from './narration-align';

export interface CourseIntegrityHeal {
  /** Scene patches to apply (updateScene), in scene order; only changed fields. */
  readonly updates: Array<{ sceneId: string; patch: Partial<Pick<Scene, 'actions' | 'content'>> }>;
  /** Interactive scenes whose widget script cannot run. */
  readonly brokenWidgets: Array<{ sceneId: string; message: string }>;
  readonly report: {
    narrationFamilies: number;
    anchorsStripped: number;
    idsRenamed: number;
    quizKeysHealed: number;
    spotlightsAdded: number;
  };
}

export interface CourseIntegrityOptions {
  /** Add spotlights to slides whose narration points at nothing (default true). */
  readonly autoSpotlight?: boolean;
}

/** Base id shared by a scene and its split parts (`__pN`, with any salt). */
function familyBase(sceneId: string): string {
  return sceneId.replace(/__p\d+(?:-[a-z0-9]+)?$/i, '');
}

function slideText(scene: Scene): string {
  const content = scene.content as { canvas?: { elements?: Array<{ content?: unknown }> } };
  return (content.canvas?.elements ?? [])
    .map((element) => (typeof element.content === 'string' ? plainText(element.content) : ''))
    .join(' ');
}

export function healCourseIntegrity(
  scenes: readonly Scene[],
  options: CourseIntegrityOptions = {},
): CourseIntegrityHeal {
  const report = {
    narrationFamilies: 0,
    anchorsStripped: 0,
    idsRenamed: 0,
    quizKeysHealed: 0,
    spotlightsAdded: 0,
  };
  const brokenWidgets: CourseIntegrityHeal['brokenWidgets'] = [];
  const working = new Map<string, Scene>();
  const changed = new Map<string, Set<'actions' | 'content'>>();
  const mark = (sceneId: string, field: 'actions' | 'content') => {
    changed.set(sceneId, (changed.get(sceneId) ?? new Set()).add(field));
  };
  const editable = (scene: Scene): Scene => {
    let copy = working.get(scene.id);
    if (!copy) {
      copy = structuredClone(scene);
      working.set(scene.id, copy);
    }
    return copy;
  };

  for (const scene of scenes) {
    if (scene.type === 'slide') {
      const copy = editable(scene);
      const renamed = dedupeElementIds(copy as never);
      const stripped = stripDeadActionAnchors(copy as never);
      if (renamed > 0) mark(scene.id, 'content');
      if (stripped > 0) mark(scene.id, 'actions');
      report.idsRenamed += renamed;
      report.anchorsStripped += stripped;
    } else if (scene.type === 'quiz') {
      const questions = (scene.content as { questions?: unknown[] }).questions ?? [];
      const heals = questions.map((question) => healedAnswerKey(question as never));
      if (heals.some((answer) => answer !== null)) {
        const copy = editable(scene);
        const copyQuestions = (copy.content as { questions: Array<{ answer?: string[] }> })
          .questions;
        heals.forEach((answer, index) => {
          if (answer === null) return;
          copyQuestions[index]!.answer = answer;
          report.quizKeysHealed += 1;
        });
        mark(scene.id, 'content');
      }
    } else if (scene.type === 'interactive') {
      const html = (scene.content as { html?: unknown }).html;
      const failure = typeof html === 'string' ? findWidgetScriptFailure(html) : null;
      if (failure) {
        brokenWidgets.push({
          sceneId: scene.id,
          message: `widget script ${failure.scriptIndex} cannot run: ${failure.message}`,
        });
      }
    }
  }

  // Split narration, on the already-healed slides.
  const families = new Map<string, Scene[]>();
  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const base = familyBase(scene.id);
    families.set(base, [...(families.get(base) ?? []), working.get(scene.id) ?? scene]);
  }
  for (const [base, members] of families) {
    if (members.length < 2) continue;
    const parts = [...members].sort((a, b) => a.order - b.order);
    const [first, ...rest] = parts;
    if (!first || first.id !== base) continue;
    const actions = (first.actions ?? []) as Action[];
    const silentRest = rest.every((part) => (part.actions ?? []).length === 0);
    const anchorFree = actions.every(
      (action) => typeof (action as { elementId?: unknown }).elementId !== 'string',
    );
    const speaks = actions.some((action) => action.type === 'speech');
    if (!silentRest || !anchorFree || !speaks) continue;
    const placement = alignActionsToParts(
      actions as Array<{ type: string; text?: string }>,
      parts.map(slideText),
    );
    if (placement.every((part) => part === 0)) continue;
    parts.forEach((part, partIndex) => {
      const copy = editable(part);
      copy.actions = actions.filter((_, index) => placement[index] === partIndex);
      mark(part.id, 'actions');
    });
    report.narrationFamilies += 1;
  }

  // Spotlights last: they see the narration where it now plays.
  if (options.autoSpotlight !== false) {
    for (const scene of scenes) {
      if (scene.type !== 'slide') continue;
      const current = working.get(scene.id) ?? scene;
      const next = withAutoSpotlights(current);
      if (!next) continue;
      report.spotlightsAdded += next.length - (current.actions ?? []).length;
      editable(scene).actions = next;
      mark(scene.id, 'actions');
    }
  }

  const updates = scenes
    .filter((scene) => changed.has(scene.id))
    .map((scene) => {
      const copy = working.get(scene.id)!;
      const fields = changed.get(scene.id)!;
      return {
        sceneId: scene.id,
        patch: {
          ...(fields.has('actions') ? { actions: copy.actions } : {}),
          ...(fields.has('content') ? { content: copy.content } : {}),
        },
      };
    });
  return { updates, brokenWidgets, report };
}
