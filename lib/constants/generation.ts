/**
 * Constants for PDF content generation
 * Shared between client and server code
 */

// PDF content truncation limit (characters)
export const MAX_PDF_CONTENT_CHARS = 50000;

// Maximum number of images to send as vision content parts
export const MAX_VISION_IMAGES = 20;

// ==================== Full-document coverage (Phase 2 §16) ====================
// The outline stage must see the WHOLE source document, not the first N
// characters. Below RAW_THRESHOLD the extracted text is injected as-is;
// above it a coverage digest (enumerative section cards with page anchors)
// replaces raw text in the outline prompt. The full text itself is chunked
// once and retrieved per scene (lib/generation/pdf-retrieval.ts) — the
// digest is only the map, retrieval is the terrain.
//
// Coverage commitments (no silent loss):
// - Only extraction noise is stripped, never content paragraphs.
// - Section cards are enumerative (every topic listed), not narrative.
// - Chapters never merge; proportional render quotas, not uniform cuts.
// - The lens pass may reorder emphasis but never removes sections.
// - lib/generation/coverage-audit.ts reports chapters with zero cited
//   pages after the outline stage so gaps are visible, not silent.

// Total extracted chars at or below which the outline stage reads raw text.
export const DIGEST_RAW_THRESHOLD_CHARS = 12_000;

// Render budget for the coverage view injected into the outline prompt. Kept
// tight: the full digest (all sections) still drives per-scene retrieval and
// the coverage audit; only the outline PLANNING summary is bounded here.
export const DIGEST_TARGET_CHARS = 12_000;

// Max raw chars sent per digest batch call (level-1 section cards).
export const DIGEST_BATCH_CHARS = 4_500;

// A section needs at least this many chars for its own card; smaller runs
// merge into the preceding card (their headings are all preserved).
export const DIGEST_MIN_SECTION_CHARS = 700;

// Upload-time captioning pass: images per vision call. All images are
// captioned (cached by content hash) so every image carries a real text
// description — no "metadata-only" image anywhere in the pipeline.
export const CAPTION_BATCH_IMAGES = 10;

// Per-call vision budget at scene content generation: only images relevant
// to the scene (suggested ids) get vision; the rest use their captions.
export const VISION_PER_SCENE_IMAGES = 6;

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

// Phase 2 §15.1: a unit (chapter) groups this many lessons. Below the
// threshold the course stays single-unit (today's shape).
export const LESSONS_PER_UNIT = 4;

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

// ==================== Content depth levels (Phase 2 §15.4) ====================
// A depth level raises the depth contract's floor (Pillar 3). Derived from
// the size preset at outline stage (compact → intro, standard →
// intermediate, intensive/semester → university) and stamped onto the
// blueprint and every outline so the content stage can enforce it.

export type CourseDepthLevel = 'intro' | 'intermediate' | 'university';

export interface CourseDepthFloor {
  /** Minimum substantive slide text elements. */
  minSubstantive: number;
  /** Minimum cited source markers when retrieval context is present. */
  minCitations: number;
  /** Minimum quiz option count for choice questions (distractors). */
  minOptions: number;
}

export const COURSE_DEPTH_FLOORS: Record<CourseDepthLevel, CourseDepthFloor> = {
  intro: { minSubstantive: 4, minCitations: 2, minOptions: 2 },
  intermediate: { minSubstantive: 5, minCitations: 2, minOptions: 2 },
  university: { minSubstantive: 6, minCitations: 3, minOptions: 3 },
};

export function depthLevelForPreset(preset: CourseSizePreset): CourseDepthLevel {
  if (preset === 'intensive' || preset === 'semester') return 'university';
  if (preset === 'standard') return 'intermediate';
  return 'intro';
}

/** Normalize an untrusted depth level to a valid one (intro on garbage). */
export function resolveDepthLevel(value: unknown): CourseDepthLevel {
  return typeof value === 'string' && value in COURSE_DEPTH_FLOORS
    ? (value as CourseDepthLevel)
    : 'intro';
}

// ==================== Specialized scene floors (Phase 2 §15.4b) ====================
// Floors for the structured scene kinds (exercise / derivation / glossary /
// reading). Each kind has its own count floor that scales with the course
// depth level; citation minimums reuse the shared floor above.

export interface SpecialtyDepthFloor {
  /** Minimum fully-worked problems on an exercise scene (statement + solution). */
  minProblems: number;
  /** Minimum derivation steps (latex + explanation). */
  minDerivationSteps: number;
  /** Minimum glossary terms. */
  minGlossaryTerms: number;
  /** Minimum further-reading items. */
  minReadingItems: number;
}

export const SPECIALTY_DEPTH_FLOORS: Record<CourseDepthLevel, SpecialtyDepthFloor> = {
  intro: { minProblems: 1, minDerivationSteps: 2, minGlossaryTerms: 4, minReadingItems: 3 },
  intermediate: { minProblems: 1, minDerivationSteps: 3, minGlossaryTerms: 5, minReadingItems: 4 },
  university: { minProblems: 2, minDerivationSteps: 4, minGlossaryTerms: 6, minReadingItems: 5 },
};

/**
 * Render the depth directive injected into the slide/quiz content prompts.
 * Empty for intro (today's behavior unchanged); raises the floor for
 * intermediate and university levels.
 */
export function renderDepthDirective(level: CourseDepthLevel): string {
  if (level === 'intro') {
    return [
      'Depth requirement: intro level.',
      '- Prefer at least one concrete worked example (real numbers/values) over purely abstract restatements.',
    ].join('\n');
  }
  if (level === 'intermediate') {
    return [
      'Depth requirement: intermediate level.',
      '- Every scene needs at least 5 substantive claims (complete sentences), not bullet captions.',
      '- Cite at least 2 [source ...] markers from the source material.',
      '- Prefer one concrete worked example with real numbers over two abstract restatements.',
    ].join('\n');
  }
  return [
    'Depth requirement: UNIVERSITY level. This is a full university course scene.',
    '- Every scene needs at least 6 substantive claims (complete sentences), not bullet captions.',
    '- Include at least one worked example or derivation with concrete numbers/formulas.',
    '- Cite at least 3 [source ...] markers from the source material.',
    '- Quizzes: every choice question needs at least 3 options, with distractors mirroring real student misconceptions.',
    '- Definitions must state preconditions and edge cases, not one-liners.',
  ].join('\n');
}

// Corrective retry budget for the outline stage: the blueprint must
// validate within this many attempts or the run fails with the report
// (never fabricate).
export const MAX_BLUEPRINT_ATTEMPTS = 3;

// Corrective retry budget for the scene-content stage: beyond the first
// call, this many depth-corrected re-prompts. On exhaustion the scene
// fails with the depth report — shallow content is never accepted.
export const MAX_CONTENT_ATTEMPTS = 2;

// Bounded concurrency for the independent LLM calls of the coverage digest
// and the multi-unit outline stage (see lib/utils/concurrency.ts). Caps
// in-flight calls so a semester run parallelizes without hammering the model
// API / rate limits.
export const LLM_CALL_CONCURRENCY = 6;

// Depth contract defaults (lib/generation/content-depth.ts): a slide needs
// at least this many substantive text elements (complete claims/sentences),
// caption fragments may not dominate, and a concrete example/definition/
// fact is required unless the outline is intro/summary.
export const MIN_SUBSTANTIVE_ELEMENTS = 4;
