/**
 * Build the lesson vocabulary the router needs from live scenes.
 *
 * A lesson is a scene the learner can open. Its concepts come from the
 * assessment items that point at it: quiz questions and exam pool items carry
 * the teaching outline they were generated from, and an activity teaches its
 * own scene-level tags. Nothing is inferred from titles or key points here; an
 * unlinked item contributes no route target, which keeps a stale or
 * hand-written link from sending a learner somewhere unrelated.
 *
 * Only live scenes become lessons, so a recommendation can always be opened.
 * A remediation id whose scene was deleted is dropped rather than turned into
 * a dead link.
 */

import { normalizeConceptTags } from '@openmaic/dsl';

import type { ExamKind, ExamSpec } from '@/lib/types/exam';
import type { Scene } from '@/lib/types/stage';

import type { RouteLesson } from './route';

function addConcepts(target: Map<string, Set<string>>, sceneId: string, concepts: unknown): void {
  const tags = normalizeConceptTags(concepts);
  if (!tags) return;
  let set = target.get(sceneId);
  if (!set) {
    set = new Set<string>();
    target.set(sceneId, set);
  }
  for (const tag of tags) set.add(tag);
}

/**
 * Derive lesson concept sets from the course's own assessment links.
 *
 * Scene order is the lesson order. A differently ordered array is fine: the
 * planner sorts before deciding. Concepts are normalized and deduplicated, so
 * a quiz and an exam naming the same idea do not split the lesson's set.
 */
export function routeLessonsFromScenes(
  scenes: readonly Scene[],
  exams?: Partial<Record<ExamKind, ExamSpec>>,
): RouteLesson[] {
  const sceneByOutlineId = new Map<string, Scene>();
  for (const scene of scenes) {
    // First wins, matching the review UI's `find`-by-outline lookup. A
    // duplicated outline id should not retarget a link to a later scene.
    if (scene.outlineId && !sceneByOutlineId.has(scene.outlineId)) {
      sceneByOutlineId.set(scene.outlineId, scene);
    }
  }

  const conceptsBySceneId = new Map<string, Set<string>>();
  const addToOutline = (outlineId: string | undefined, concepts: unknown): void => {
    if (!outlineId) return;
    const scene = sceneByOutlineId.get(outlineId);
    if (!scene) return;
    addConcepts(conceptsBySceneId, scene.id, concepts);
  };

  for (const scene of scenes) {
    const content = scene.content;
    if (content.type === 'activity') {
      addConcepts(conceptsBySceneId, scene.id, content.concepts);
      continue;
    }
    if (content.type === 'quiz') {
      for (const question of content.questions) {
        addToOutline(question.remediationOutlineId, question.concepts);
      }
    }
  }

  for (const spec of Object.values(exams ?? {})) {
    if (!spec) continue;
    for (const item of [...spec.mcQuestions, ...spec.frQuestions]) {
      addToOutline(item.remediationOutlineId, item.concepts);
    }
  }

  const lessons: RouteLesson[] = [];
  for (const [index, scene] of scenes.entries()) {
    const concepts = conceptsBySceneId.get(scene.id);
    if (!concepts || concepts.size === 0) continue;
    lessons.push({
      sceneId: scene.id,
      title: scene.title,
      order: Number.isFinite(scene.order) ? scene.order : index,
      conceptIds: [...concepts].sort(),
    });
  }
  return lessons;
}
