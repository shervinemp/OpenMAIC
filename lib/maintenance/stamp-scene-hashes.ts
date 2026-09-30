import { createLogger } from '@/lib/logger';
import type { Scene } from '@/lib/types/stage';

const log = createLogger('StampSceneHashes');

/**
 * Hash-stamping for load-time scenes that carry materialized work but no
 * `actionsSourceHash` (or `outlineSourceHash`) fingerprint (split-terminal part scenes, legacy rows).
 * Extracted from the classroom's console-only `__openmaicStampSceneHashes`
 * so the same stamping runs unconditionally in the on-load pipeline — after
 * the split terminal creates parts, their re-verification debt closes in the
 * same session.
 *
 * Doctrine: the hash always reflects the CURRENT stored content under
 * deterministic generation params, so a later mismatch (blueprint edit)
 * invalidates and re-pays content for that scene — never silent reuse.
 * Idempotent: stamped scenes are skipped.
 */
export interface StampReport {
  stamped: number;
  total: number;
}

/** One stamp pass per course per session; module-scoped by design. */
const stampedCourses = new Set<string>();

export async function stampCourseSceneHashes(
  stageId: string,
  options: { again?: boolean } = {},
): Promise<StampReport | null> {
  // `again` is for a second look in the same session, after something (the
  // split terminal) created scenes the first pass could not have seen.
  if (!stageId || (stampedCourses.has(stageId) && !options.again)) return null;
  stampedCourses.add(stageId);
  const { useStageStore } = await import('@/lib/store');
  const state = useStageStore.getState();
  if (!state.stage) return null;
  try {
    const { loadGenerationParams } = await import('@/lib/utils/generation-session-store');
    const restored = await loadGenerationParams(stageId);
    const {
      agents,
      userProfile,
      languageDirective = state.stage.languageDirective,
    } = restored ?? {};
    const { computeActionsSourceHash } = await import('@/lib/utils/content-hash');
    const { outlineFingerprint } = await import('@/lib/utils/outline-fingerprint');
    const outlineById = new Map(state.outlines.map((outline) => [outline.id, outline]));
    // Stamps per scene id, applied to the CURRENT scenes below: the awaits above
    // let the store move on (integrity heals, layout writes), and writing back a
    // snapshot taken before them would undo those.
    const stampsById = new Map<string, Partial<Scene>>();
    for (const scene of state.scenes) {
      const stamps: Partial<Scene> = {};
      if (scene.actionsSourceHash === undefined) {
        stamps.actionsSourceHash = computeActionsSourceHash({
          content: scene.content,
          agents,
          userProfile,
          languageDirective,
        });
      }
      // The plan the scene answers to. A scene that predates the stamp adopts
      // the CURRENT outline as its baseline: what it was generated from is
      // unknowable, and treating every old scene as stale would queue a whole
      // course for regeneration on first open.
      const outline = scene.outlineId ? outlineById.get(scene.outlineId) : undefined;
      if (scene.outlineSourceHash === undefined && outline) {
        stamps.outlineSourceHash = outlineFingerprint(outline);
      }
      if (Object.keys(stamps).length > 0) stampsById.set(scene.id, stamps);
    }
    if (stampsById.size === 0) return { stamped: 0, total: state.scenes.length };

    // Applied straight to the store, and deliberately NOT persisted. `setScenes`
    // marks the whole deck's structure dirty, and marking scenes dirty writes
    // each one: for a course of a thousand scenes that is a full-document save
    // (refused by the server's lost-update fence whenever maintenance has moved
    // the document on) or a thousand row writes, each followed by a course-git
    // commit. A baseline adopted for a scene that predates the stamp is
    // therefore per session: it catches a plan that changes while the course is
    // open, not one changed between sessions. Scenes generated from now on
    // carry their stamp in the write that created them, and are checked across
    // sessions.
    let stamped = 0;
    useStageStore.setState((current) => ({
      scenes: current.scenes.map((scene) => {
        const stamps = stampsById.get(scene.id);
        if (!stamps) return scene;
        const missing: Partial<Scene> = {};
        if (stamps.actionsSourceHash && scene.actionsSourceHash === undefined) {
          missing.actionsSourceHash = stamps.actionsSourceHash;
        }
        if (stamps.outlineSourceHash && scene.outlineSourceHash === undefined) {
          missing.outlineSourceHash = stamps.outlineSourceHash;
        }
        if (Object.keys(missing).length === 0) return scene;
        stamped += 1;
        return { ...scene, ...missing } as Scene;
      }),
    }));
    log.info(`stamped ${stamped}/${state.scenes.length} scene action hashes on load`);
    return { stamped, total: state.scenes.length };
  } catch (error) {
    log.warn('auto stamp failed (non-fatal)', error);
    return null;
  }
}
