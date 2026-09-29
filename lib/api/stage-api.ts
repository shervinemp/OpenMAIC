/**
 * Stage API - AI Agent Toolkit
 *
 * Provides a complete Stage operation interface for AI Agents to create and manage course content
 *
 * Design Principles:
 * 1. Type Safety: Fully leverage TypeScript's type system
 * 2. Ease of Use: Provide high-level abstractions with clear, intuitive API naming
 * 3. Extensibility: Support adding new scene types in the future
 * 4. Idempotency: Multiple calls with the same parameters produce the same result
 * 5. Error Handling: Return explicit success/failure status and error messages
 *
 * @example
 * ```typescript
 * const api = createStageAPI(stageStore);
 *
 * // Create a new scene
 * const sceneId = api.scene.create({
 *   type: 'slide',
 *   title: 'Introduction',
 *   // speech is now in actions
 * });
 *
 * // Add an element
 * const elementId = api.element.add(sceneId, {
 *   type: 'text',
 *   content: 'Hello World',
 *   left: 100,
 *   top: 100
 * });
 *
 * // Highlight an element (teaching feature)
 * api.canvas.highlight(sceneId, elementId, 3000);
 * ```
 */

// Re-export all types
export type {
  APIResult,
  CreateSceneParams,
  CreateElementParams,
  HighlightOptions,
  SpotlightOptions,
  StageStore,
} from './stage-api-types';

// Re-export utility functions that were previously accessible
export {
  generateId,
  validateSceneId,
  getScene,
  createDefaultContent,
  createDefaultSlideContent,
  createDefaultQuizContent,
  createDefaultInteractiveContent,
  createDefaultPBLContent,
} from './stage-api-defaults';

// Import sub-API factories
import { createSceneAPI } from './stage-api-scene';
import { createElementAPI } from './stage-api-element';
import { createCanvasAPI } from './stage-api-canvas';
import { createNavigationAPI } from './stage-api-navigation';
import { createWhiteboardAPI } from './stage-api-whiteboard';
import { createModeAPI, createStageMetaAPI } from './stage-api-mode';
import type { StageStore } from './stage-api-types';
import { markStagePersistenceDirty, useStageStore } from '@/lib/store/stage';
import type { PendingChange } from '@/lib/utils/stage-storage';

function persistenceChangesForSetState(
  before: ReturnType<StageStore['getState']>,
  after: ReturnType<StageStore['getState']>,
): PendingChange[] {
  const changes: PendingChange[] = [];

  if (before.stage !== after.stage) changes.push({ kind: 'stage' });
  if (before.currentSceneId !== after.currentSceneId) changes.push({ kind: 'currentScene' });

  if (before.scenes !== after.scenes) {
    const beforeStructure = before.scenes.map(({ id, order }) => [id, order] as const);
    const afterStructure = after.scenes.map(({ id, order }) => [id, order] as const);
    const structureChanged =
      beforeStructure.length !== afterStructure.length ||
      beforeStructure.some(
        ([id, order], index) =>
          afterStructure[index]?.[0] !== id || afterStructure[index]?.[1] !== order,
      );

    if (structureChanged) {
      changes.push({ kind: 'structure' });
    } else {
      before.scenes.forEach((scene, index) => {
        if (scene !== after.scenes[index]) changes.push({ kind: 'scene', sceneId: scene.id });
      });
    }
  }

  return changes;
}

/**
 * Advance the revision clock on every scene this boundary replaces.
 *
 * A scene object handed to `setState` is a new revision, and the server's
 * stale-scene fence (`@openmaic/storage` `putScene`) refuses any write whose
 * `updatedAt` is older than the stored copy. The refusal is silent — a 409 in a
 * log — and the autosave turns it into an unbounded retry of a write that can
 * never succeed, dropping every dirty scene queued behind it.
 *
 * This applies to EVERY store, not just the production one: the server's
 * in-memory classroom generator runs the same modules, and the persisted
 * document outlives the request. The per-call-site `updatedAt: Date.now()`
 * this replaces was duplicated at nine sites and unenforced, which is how three
 * other live paths in the app came to violate it.
 */
function withRevisionClock(store: StageStore): StageStore {
  return {
    ...store,
    setState(partial) {
      const before = store.getState();
      store.setState(partial);
      const after = store.getState();
      if (after.scenes === before.scenes) return;
      // Keyed by id, not index: a reordered or inserted scene is not an edit,
      // and position-keyed comparison would stamp every scene after the shift.
      const previous = new Map(before.scenes.map((candidate) => [candidate.id, candidate]));
      const now = Date.now();
      let changed = false;
      const stamped = after.scenes.map((candidate) => {
        if (previous.get(candidate.id) === candidate) return candidate;
        changed = true;
        return { ...candidate, updatedAt: now };
      });
      if (!changed) return;
      // `store` here is the raw store, not this wrapper, so this does not
      // re-enter the clock.
      store.setState({ scenes: stamped });
    },
  };
}

function withProductionPersistence(store: StageStore): StageStore {
  const clocked = withRevisionClock(store);
  // The revision clock above is for every store; the dirty-marking that
  // schedules persistence is for the live one only.
  if (store !== useStageStore) return clocked;
  return {
    ...clocked,
    setState(partial) {
      const before = store.getState();
      clocked.setState(partial);
      const changes = persistenceChangesForSetState(before, store.getState());
      if (changes.length > 0) markStagePersistenceDirty(changes);
    },
  };
}

// ==================== Stage API Implementation ====================

/**
 * Create a Stage API instance
 *
 * @param store - Zustand store instance
 * @returns Stage API object
 */
export function createStageAPI(store: StageStore) {
  // All namespaces receive the same guarded injection boundary. New API
  // modules cannot bypass persistence by adding another raw setState call.
  const persistenceStore = withProductionPersistence(store);
  return {
    scene: createSceneAPI(persistenceStore),
    navigation: createNavigationAPI(persistenceStore),
    element: createElementAPI(persistenceStore),
    canvas: createCanvasAPI(persistenceStore),
    whiteboard: createWhiteboardAPI(persistenceStore),
    mode: createModeAPI(persistenceStore),
    stage: createStageMetaAPI(persistenceStore),
  };
}

// ==================== Type Exports ====================

export type StageAPI = ReturnType<typeof createStageAPI>;
