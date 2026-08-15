import type { MaicDocument } from '@openmaic/storage';
import type { Stage } from '@openmaic/dsl';

import type { CourseBlueprint, SceneOutline } from '@/lib/types/generation';
import type { AppScene } from '@/lib/types/stage';

/** App-owned stage shape. Device playback position is not document metadata. */
export type AppStage = Stage;

// ==================== Generation job state (Pillar 2) ====================

export type OutlinePhaseName = 'content' | 'actions' | 'tts' | 'media';

export interface OutlinePhaseState {
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  /** Last failure detail (transient/permanent). */
  error?: string;
  updatedAt: number;
}

export interface SceneJobState {
  /** Reference into `blueprint.lessons[].outlines` — outlines are stored
      once; the flat `outlines` field is the compat projection. */
  outlineId: string;
  /** Bound once content+actions commit a scene. */
  sceneId?: string;
  phases: Record<OutlinePhaseName, OutlinePhaseState>;
  /** User closes a permanently failed job: skip = finalize without the
      scene; accept = keep the partial content. */
  resolution?: 'skip' | 'accept';
}

export interface LessonJobGroup {
  /** Reference into `blueprint.lessons` (positional, 1-based lesson id). */
  lessonId: string;
  /** Phase state for this lesson's scenes, in global order. */
  jobs: SceneJobState[];
}

export interface OutlineCompletion {
  allResolved: boolean;
  completedAt?: number;
}

/**
 * Generation intent stored opaquely with the document aggregate.
 *
 * v2 (Pillar 1 + 2): `blueprint` is the curriculum contract and the single
 * source of outlines; `lessonGroups` carry per-outline per-phase job state;
 * `completion` is the defined predicate. The flat `outlines` array remains
 * as the compat projection for the stage-store load path and is kept in
 * sync by `flattenBlueprintOutlines` / `canonicalizeOutlineV2`.
 */
export interface AppDocumentOutline {
  outlines: SceneOutline[];
  generationComplete?: boolean;
  blueprint?: CourseBlueprint;
  lessonGroups?: LessonJobGroup[];
  completion?: OutlineCompletion;
  createdAt: number;
  updatedAt: number;
}

/** Canonical app document persisted through the document-store seam. */
export type AppDocument = MaicDocument<AppScene, AppStage>;
