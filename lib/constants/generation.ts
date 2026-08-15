/**
 * Constants for PDF content generation
 * Shared between client and server code
 */

// PDF content truncation limit (characters)
export const MAX_PDF_CONTENT_CHARS = 50000;

// Maximum number of images to send as vision content parts
export const MAX_VISION_IMAGES = 20;

// ==================== Course Blueprint Contract ====================
// The curriculum shape is a validated contract (see
// lib/generation/blueprint.ts): scene count is derived from a resolved
// duration and enforced by validateBlueprint — never accepted on model
// whim.

// Course-wide floor/cap on scene count. The cap is a cost guard, not the
// norm: a 20-minute course yields 20 scenes at SCENES_PER_MINUTE = 1.0.
export const MIN_SCENES = 5;
export const MAX_SCENES = 30;

// Per-lesson bounds. Lessons are split deterministically from the
// course-wide total (greedy even split, larger parts first).
export const MIN_SCENES_PER_LESSON = 3;
export const MAX_SCENES_PER_LESSON = 12;

// One lesson ≈ one focused session (10 minutes of scenes at 1.0/min).
export const LESSON_MINUTES = 10;
export const MIN_LESSONS = 1;
export const MAX_LESSONS = 8;

// Depth contract ⇒ each scene carries ~60-90 s of substantive content,
// so one scene per minute (not 1.5-2) keeps the count honest.
export const SCENES_PER_MINUTE = 1.0;

// Quiz placement cadence (course-wide): every N scenes, ±1. Exam-prep
// courses quiz more aggressively.
export const QUIZ_PLACEMENT_DEFAULT = 4;
export const QUIZ_PLACEMENT_EXAM_PREP = 3;

// Resolved when the requirement carries no explicit duration and no typed
// duration was provided. Pinned (the old prompt said "15-30 min" and let
// the model choose).
export const DEFAULT_DURATION_MINUTES = 20;

// ==================== Course size presets (Phase 2 §15.3) ====================
// A preset raises the contract's caps: scene totals, lesson counts, and the
// scenes-per-minute density. Explicit durations always win over the preset's
// duration; the preset duration only applies when nothing else was given.

export type CourseSizePreset = 'compact' | 'standard' | 'intensive' | 'semester';

export interface CourseSizePresetConfig {
  /** Fallback course duration when no explicit duration was provided. */
  durationMinutes: number;
  /** Course-wide scene cap (cost guard). */
  maxScenes: number;
  /** Lesson-count cap for the deterministic split. */
  maxLessons: number;
  /** Scene density: scenes per minute of resolved duration. */
  scenesPerMinute: number;
}

export const COURSE_SIZE_PRESETS: Record<CourseSizePreset, CourseSizePresetConfig> = {
  // Today's behavior unchanged: 15-30 min, ≤30 scenes, ≤8 lessons.
  compact: { durationMinutes: 20, maxScenes: 30, maxLessons: 8, scenesPerMinute: 1.0 },
  // ~1 hour, ~60 scenes.
  standard: { durationMinutes: 60, maxScenes: 60, maxLessons: 12, scenesPerMinute: 1.0 },
  // 3-6 hours, up to 360 scenes.
  intensive: { durationMinutes: 180, maxScenes: 360, maxLessons: 30, scenesPerMinute: 2.0 },
  // Semester-scale: up to 10 hours / 600 scenes, generated over multiple sessions.
  semester: { durationMinutes: 600, maxScenes: 600, maxLessons: 48, scenesPerMinute: 1.0 },
};

export const DEFAULT_SIZE_PRESET: CourseSizePreset = 'compact';

/** Normalize an untrusted preset value to a valid one (compact on garbage). */
export function resolveSizePreset(value: unknown): CourseSizePreset {
  return typeof value === 'string' && value in COURSE_SIZE_PRESETS
    ? (value as CourseSizePreset)
    : DEFAULT_SIZE_PRESET;
}

// Corrective retry budget for the outline stage: the blueprint must
// validate within this many attempts or the run fails with the report
// (never fabricate).
export const MAX_BLUEPRINT_ATTEMPTS = 3;

// Corrective retry budget for the scene-content stage: beyond the first
// call, this many depth-corrected re-prompts. On exhaustion the scene
// fails with the depth report — shallow content is never accepted.
export const MAX_CONTENT_ATTEMPTS = 2;

// Depth contract defaults (lib/generation/content-depth.ts): a slide needs
// at least this many substantive text elements (complete claims/sentences),
// caption fragments may not dominate, and a concrete example/definition/
// fact is required unless the outline is intro/summary.
export const MIN_SUBSTANTIVE_ELEMENTS = 4;
