import type { StageOutlinesRecord, StageRecord } from '@/lib/utils/database';
import type { AppScene } from '@/lib/types/stage';
import type { CourseBlueprint, SceneOutline } from '@/lib/types/generation';
import { legacyBlueprintFromOutlines } from '@/lib/generation/blueprint';

import type {
  AppDocumentOutline,
  AppStage,
  LessonJobGroup,
  OutlinePhaseState,
} from './persistence-types';

/** Separate device playback position from canonical document metadata. */
export function canonicalizeLegacyStage<T extends StageRecord>(
  record: T,
): { stage: AppStage & Omit<T, 'currentSceneId'>; currentSceneId: T['currentSceneId'] } {
  const { currentSceneId, ...stage } = record;
  return { stage, currentSceneId };
}

/** Normalize legacy scene aliases without interpreting app-owned payloads. */
export function canonicalizeLegacyScene(record: object): AppScene {
  const source = record as Record<string, unknown>;
  const { whiteboard, ...canonical } = source;
  if (!Object.prototype.hasOwnProperty.call(canonical, 'whiteboards') && whiteboard !== undefined) {
    canonical.whiteboards = whiteboard;
  }
  const content = canonical.content as { type: AppScene['type'] };
  return { ...canonical, type: content.type } as AppScene;
}

/** Remove the legacy table key from the opaque document-outline envelope. */
export function canonicalizeLegacyOutline(record: StageOutlinesRecord): AppDocumentOutline {
  const { stageId: _stageId, ...outline } = record;
  return outline;
}

// ==================== v2 job-model canonicalization (Pillar 1 + 2) ====================

/** Flatten a blueprint into the compat `outlines` projection (lessonId attached). */
export function flattenBlueprintOutlines(blueprint: CourseBlueprint): SceneOutline[] {
  return blueprint.lessons.flatMap((lesson) => lesson.outlines);
}

function pendingPhase(): OutlinePhaseState {
  return { status: 'pending', attempts: 0, updatedAt: Date.now() };
}

/**
 * Build per-lesson job groups from a blueprint. Jobs reference the
 * blueprint's outlines by id; phase state starts pending (the caller's job
 * model drives transitions — see Pillar 2).
 */
export function buildLessonGroupsFromBlueprint(blueprint: CourseBlueprint): LessonJobGroup[] {
  return blueprint.lessons.map((lesson, lessonIndex) => ({
    lessonId: `lesson_${lessonIndex + 1}`,
    jobs: lesson.outlines.map((outline) => ({
      outlineId: outline.id,
      phases: {
        content: pendingPhase(),
        actions: pendingPhase(),
        tts: pendingPhase(),
        media: pendingPhase(),
      },
    })),
  }));
}

/**
 * Canonicalize a legacy flat outline record into the v2 shape: a
 * single-lesson blueprint (legacy counts are exempt from the contract),
 * matching job groups, and the completion predicate projected from the
 * legacy `generationComplete` flag.
 *
 * The flat `outlines` array is preserved as the compat projection, so
 * existing stage-store readers keep working unchanged.
 */
export function canonicalizeOutlineV2(
  record: StageOutlinesRecord,
  title: string,
  languageDirective?: string,
): AppDocumentOutline {
  const { stageId: _stageId, generationComplete, outlines, createdAt, updatedAt } = record;

  const blueprint = legacyBlueprintFromOutlines(outlines ?? [], title, languageDirective);
  const lessonGroups = buildLessonGroupsFromBlueprint(blueprint);

  // A legacy deck marked complete had its content and actions committed;
  // fill phases (tts/media) stay pending and re-run on next open (bounded
  // by provider health).
  if (generationComplete) {
    for (const group of lessonGroups) {
      for (const job of group.jobs) {
        job.phases.content = { ...job.phases.content, status: 'done' };
        job.phases.actions = { ...job.phases.actions, status: 'done' };
      }
    }
  }

  return {
    outlines: outlines ?? [],
    generationComplete,
    blueprint,
    lessonGroups,
    completion: { allResolved: !!generationComplete },
    createdAt,
    updatedAt,
  };
}
