/**
 * Stage-keyed client generation controllers.
 *
 * The classroom generator keeps its AbortController in a hook ref, which a
 * delete handler elsewhere in the app cannot reach. This tiny registry lets a
 * destructive action (deleting a course) stop that course's in-flight fetches
 * before the document is removed — otherwise the still-running generator
 * re-persists the stage right after the delete, making the course reappear.
 *
 * Server routes see the aborted fetches through their request signals (they
 * use anyAbortSignal(req.signal, ...)), so the upstream LLM calls stop too.
 */

const controllers = new Map<string, AbortController>();

export function registerStageGeneration(stageId: string, controller: AbortController): void {
  controllers.set(stageId, controller);
}

export function unregisterStageGeneration(stageId: string, controller: AbortController): void {
  if (controllers.get(stageId) === controller) controllers.delete(stageId);
}

/** Abort every in-flight generation fetch for this stage. Idempotent. */
export function abortStageGeneration(stageId: string): void {
  const controller = controllers.get(stageId);
  controllers.delete(stageId);
  controller?.abort();
}
