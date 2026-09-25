import { createLogger } from '@/lib/logger';

const log = createLogger('StampSceneHashes');

/**
 * Hash-stamping for load-time scenes that carry materialized work but no
 * `actionsSourceHash` fingerprint (split-terminal part scenes, legacy rows).
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

export async function stampCourseSceneHashes(stageId: string): Promise<StampReport | null> {
  if (!stageId || stampedCourses.has(stageId)) return null;
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
    let stamped = 0;
    const scenes = state.scenes.map((scene) => {
      if (scene.actionsSourceHash !== undefined) return scene;
      stamped += 1;
      return {
        ...scene,
        actionsSourceHash: computeActionsSourceHash({
          content: scene.content,
          agents,
          userProfile,
          languageDirective,
        }),
      };
    });
    if (stamped === 0) return { stamped: 0, total: state.scenes.length };
    state.setScenes(stamped === state.scenes.length ? [...scenes] : scenes);
    log.info(`stamped ${stamped}/${state.scenes.length} scene action hashes on load`);
    return { stamped, total: state.scenes.length };
  } catch (error) {
    log.warn('auto stamp failed (non-fatal)', error);
    return null;
  }
}
