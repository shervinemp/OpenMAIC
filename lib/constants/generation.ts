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

// Corrective retry budget for the outline stage: the blueprint must
// validate within this many attempts or the run fails with the report
// (never fabricate).
export const MAX_BLUEPRINT_ATTEMPTS = 3;
