/**
 * Course Blueprint — the curriculum as a contract (Pillar 1).
 *
 * The outline stage no longer accepts scene counts on model whim. The
 * resolved duration is derived first (typed input → text parse → default),
 * the course-wide scene total and lesson split are computed
 * deterministically, and the parsed outlines are assembled into a
 * `CourseBlueprint` that must pass `validateBlueprint` — with a bounded
 * corrective retry loop — before the deck is accepted.
 *
 * Pure functions only; no I/O, no Next.js deps. Shared by the
 * non-streaming outline generator and the SSE outline route.
 */

import {
  COURSE_SIZE_PRESETS,
  DEFAULT_DURATION_MINUTES,
  DEFAULT_SIZE_PRESET,
  depthLevelForPreset,
  LESSONS_PER_UNIT,
  LESSON_MINUTES,
  MAX_BLUEPRINT_ATTEMPTS,
  MIN_LESSONS,
  MIN_SCENES,
  MIN_SCENES_PER_LESSON,
  QUIZ_PLACEMENT_DEFAULT,
  QUIZ_PLACEMENT_EXAM_PREP,
  resolveSizePreset,
  type CourseDepthLevel,
  type CourseSizePreset,
} from '@/lib/constants/generation';
import type {
  CourseBlueprint,
  CourseType,
  SceneOutline,
  UnitBlueprint,
} from '@/lib/types/generation';

// ==================== Duration resolution ====================

/** Clamp a duration into the sane range (1 minute .. 10 hours). */
export function clampDurationMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_DURATION_MINUTES;
  return Math.min(600, Math.max(1, Math.round(minutes)));
}

// Hours checked FIRST: "1 hour 30 minutes" must resolve to 90, not 30
// (a minutes-first scan would match the trailing "30 minutes").
const HOURS_RE = /(\d+(?:\.\d+)?)\s*(?:hour|hours|hr|hrs|小时)\b/i;
const MINUTES_RE = /(\d+(?:\.\d+)?)\s*(?:min|minutes|minute|mins|分钟|分)\b/i;

/**
 * Extract an explicit duration (minutes) from free-form requirement text.
 * Returns null when the text carries no duration signal. Hours and minutes
 * components are summed ("1 hour 30 minutes" → 90).
 */
export function parseDurationFromText(text: string): number | null {
  if (!text) return null;
  let total: number | null = null;
  const hours = text.match(HOURS_RE);
  if (hours) {
    const value = Number.parseFloat(hours[1]);
    if (Number.isFinite(value) && value > 0) total = value * 60;
  }
  const minutes = text.match(MINUTES_RE);
  if (minutes) {
    const value = Number.parseFloat(minutes[1]);
    if (Number.isFinite(value) && value > 0) total = (total ?? 0) + value;
  }
  return total === null ? null : clampDurationMinutes(total);
}

// ==================== Course type inference ====================

const EXAM_PREP_RE = /\b(exam|exams|prep|preparation|certification|certificate|associate|professional|practice test|mock)\b/i;
const HANDS_ON_RE = /\b(hands[- ]on|build|building|project[- ]based|workshop|tutorial|lab)\b/i;

/**
 * Infer the course flavor from the requirement text (not the model's
 * title — the type must be known before the prompt is built).
 */
export function inferCourseType(text: string): CourseType {
  if (EXAM_PREP_RE.test(text)) return 'exam-prep';
  if (HANDS_ON_RE.test(text)) return 'hands-on';
  return 'explainer';
}

// ==================== Contract derivation ====================

export interface CourseContract {
  /** Resolved course duration (minutes). */
  durationMinutes: number;
  /** Course-wide scene total — computed FIRST, then distributed. */
  totalSceneTarget: number;
  /** Number of lessons (clamped split). */
  lessonCount: number;
  /** Per-lesson scene targets (sums to totalSceneTarget). */
  lessonSceneTargets: number[];
  /** Number of units (chapters); 1 = today's single-unit shape. */
  unitCount: number;
  /** Per-unit lesson counts (sums to lessonCount). */
  unitLessonCounts: number[];
  /** Quiz cadence (every N scenes, course-wide). */
  quizPlacement: number;
  /** The size preset the contract was derived under. */
  sizePreset: CourseSizePreset;
  /** Content depth level derived from the preset (Phase 2 §15.4). */
  depthLevel: CourseDepthLevel;
}

/**
 * Per-lesson scene cap for a preset. Scales with the preset so a semester
 * course can put a full lecture in each lesson; compact keeps today's 12.
 */
export function perLessonSceneCap(preset: CourseSizePreset): number {
  const config = COURSE_SIZE_PRESETS[preset];
  return Math.max(
    MIN_SCENES_PER_LESSON,
    Math.min(
      config.maxScenes,
      12 + Math.floor(Math.log2(Math.max(1, config.maxScenes / 30))) * 8,
    ),
  );
}

/**
 * Derive the course contract from a resolved duration and size preset.
 *
 * Order matters: the course-wide total is computed first and then
 * distributed greedily, so the sum of lesson targets always equals the
 * total (a lesson-first derivation could overflow the preset's maxScenes).
 * The preset raises the caps: compact keeps today's behavior (≤30 scenes,
 * ≤8 lessons, 1.0 scenes/min); standard/intensive/semester scale up.
 */
export function deriveCourseContract(
  durationMinutes: number,
  courseType: CourseType = 'explainer',
  preset: CourseSizePreset = DEFAULT_SIZE_PRESET,
): CourseContract {
  const config = COURSE_SIZE_PRESETS[preset];
  const duration = clampDurationMinutes(durationMinutes);

  const rawTotal = Math.round(duration * config.scenesPerMinute);
  const totalSceneTarget = Math.min(config.maxScenes, Math.max(MIN_SCENES, rawTotal));

  const lessonCount = Math.min(
    config.maxLessons,
    Math.max(MIN_LESSONS, Math.ceil(duration / LESSON_MINUTES)),
  );

  // Greedy even split, larger parts first, each within the per-lesson
  // bounds.
  const maxScenesPerLesson = perLessonSceneCap(preset);
  const base = Math.floor(totalSceneTarget / lessonCount);
  const remainder = totalSceneTarget % lessonCount;
  const lessonSceneTargets: number[] = [];
  for (let i = 0; i < lessonCount; i++) {
    const target = Math.min(
      maxScenesPerLesson,
      Math.max(MIN_SCENES_PER_LESSON, base + (i < remainder ? 1 : 0)),
    );
    lessonSceneTargets.push(target);
  }

  const quizPlacement = courseType === 'exam-prep' ? QUIZ_PLACEMENT_EXAM_PREP : QUIZ_PLACEMENT_DEFAULT;

  // Unit split (Phase 2 §15.1): one unit per LESSONS_PER_UNIT lessons,
  // greedy distribution of the remainder onto earlier units.
  const unitCount = Math.max(1, Math.ceil(lessonCount / LESSONS_PER_UNIT));
  const unitLessonCounts: number[] = [];
  const baseLessons = Math.floor(lessonCount / unitCount);
  const remainderLessons = lessonCount % unitCount;
  for (let i = 0; i < unitCount; i++) {
    unitLessonCounts.push(baseLessons + (i < remainderLessons ? 1 : 0));
  }

  return {
    durationMinutes: duration,
    totalSceneTarget,
    lessonCount,
    lessonSceneTargets,
    unitCount,
    unitLessonCounts,
    quizPlacement,
    sizePreset: preset,
    depthLevel: depthLevelForPreset(preset),
  };
}

/**
 * Resolve the contract for a generation request: an explicit duration wins
 * over the preset's fallback duration; the preset sets the caps either way.
 */
export function deriveContractForRequest(
  presetValue: unknown,
  courseType: CourseType,
  explicitDurationMinutes?: number,
): CourseContract {
  const preset = resolveSizePreset(presetValue);
  const config = COURSE_SIZE_PRESETS[preset];
  return deriveCourseContract(
    explicitDurationMinutes ?? config.durationMinutes,
    courseType,
    preset,
  );
}

// ==================== Prompt contract rendering ====================

/**
 * Render the non-negotiable contract block injected into the outline
 * prompt. Pre-rendered in TypeScript — the prompt templating language has
 * no {{#each}}.
 */
export function renderCourseContract(contract: CourseContract, courseType: CourseType): string {
  const quizPositions = Array.from(
    { length: Math.max(1, Math.floor(contract.totalSceneTarget / contract.quizPlacement)) },
    (_, i) => contract.quizPlacement * (i + 1),
  );

  const lessons = contract.lessonSceneTargets
    .map(
      (target, index) =>
        `  Lesson ${index + 1}: EXACTLY ${target} scene outlines (global outline #${contract.lessonSceneTargets.slice(0, index).reduce((a, b) => a + b, 0) + 1} through #${contract.lessonSceneTargets.slice(0, index + 1).reduce((a, b) => a + b, 0)}). First attempt: invent a lesson title. Corrective attempts: keep the previous attempt's title.`,
    )
    .join('\n');

  // Phase 2 §15.1: unit (chapter) structure above the lessons. Lesson ranges
  // are positional — unit i covers lessons [start, end] of the list above.
  const units = contract.unitCount > 1
    ? contract.unitLessonCounts
        .map((count, index) => {
          const start = contract.unitLessonCounts.slice(0, index).reduce((a, b) => a + b, 0) + 1;
          return `  Unit ${index + 1}: exactly ${count} lessons (lessons #${start}-${start + count - 1} above). Invent a unit title and 1-2 unit-level objectives.`;
        })
        .join('\n')
    : '';

  const typeMix =
    courseType === 'exam-prep'
      ? 'Exam-prep: quiz-heavy mix — one quiz every 3rd scene (course-wide), exam-objective phrasing in keyPoints, distractors mirroring real exam traps.'
      : courseType === 'hands-on'
        ? 'Hands-on: allow 1-2 interactive scenes and at most 1 pbl; practice-oriented slides.'
        : 'Explainer: slide-heavy; at most 1-2 interactive scenes and at most 1 pbl per course.';

  const specialization = contract.depthLevel === 'intro' ? '' : `\n- Specialized scene types (Phase 2 §15.4b):\n  * "exercise" — one or two fully-worked problems (statement + worked solution; analysis at university level) for computational/quantitative lessons.\n  * "derivation" — step-by-step proof/derivation scenes with LaTeX formulas, for formula-heavy lessons.\n  * "glossary" — one per unit: the unit's key terms with complete definitions.\n  * "reading" — one per unit: annotated further-reading list (title + why-read).`;

  return `Course contract (non-negotiable):
- Produce EXACTLY ${contract.lessonCount} lessons (sections), in this order:
${lessons}
${units ? `- Unit (chapter) structure — EXACTLY ${contract.unitCount} units:\n${units}\n` : ''}- Total scenes: ${contract.totalSceneTarget} — the sum of the per-lesson targets; you may not produce fewer.
- Scene types: ${typeMix}${specialization}
- Quiz cadence (course-wide): a quiz at or near global outline #${quizPositions.join(', #')}.
- Also emit "lessons": an array of ${contract.lessonCount} objects, each {"title": "...", "objectives": ["..."]} (1-2 objectives per lesson, teaching language)${contract.unitCount > 1 ? `, "units": an array of ${contract.unitCount} objects, each {"title": "...", "objectives": ["..."]} (1-2 objectives per unit, in order)` : ''}, plus course-level "audience" (string) and "objectives" (2-5 strings).`;
}

// ==================== Canonicalization ====================

/** Lightweight parsed-wrapper shape accepted from the outline model. */
export interface ParsedOutlineResponse {
  languageDirective?: string;
  courseTitle?: string;
  outlines?: SceneOutline[];
  audience?: string;
  objectives?: string[];
  lessons?: Array<{ title?: string; objectives?: string[] }>;
  units?: Array<{
    title?: string;
    objectives?: string[];
    lessons?: Array<{ title?: string; objectives?: string[] }>;
  }>;
}

/**
 * Assign lesson membership positionally: the first `targets[0]` outlines
 * are lesson 1, the next `targets[1]` are lesson 2, and so on. The prompt
 * contract lists exact per-lesson counts in global order, so positional
 * assignment is deterministic and needs no model-provided boundaries.
 */
export function assignLessonIds(outlines: SceneOutline[], targets: number[]): SceneOutline[] {
  // End boundary of each lesson (exclusive), e.g. targets [5,5] → [5,10].
  const cumulative: number[] = [];
  let running = 0;
  for (const target of targets) {
    running += target;
    cumulative.push(running);
  }

  return outlines.map((outline, index) => {
    let lessonNumber = targets.length; // overflow → last lesson
    for (let i = 0; i < cumulative.length; i++) {
      if (index < cumulative[i]) {
        lessonNumber = i + 1;
        break;
      }
    }
    return { ...outline, lessonId: `lesson_${lessonNumber}` };
  });
}

/** Split assigned outlines into LessonBlueprints. */
export function splitIntoLessons(
  outlines: SceneOutline[],
  contract: CourseContract,
  parsed: ParsedOutlineResponse,
): CourseBlueprint['lessons'] {
  const lessons: CourseBlueprint['lessons'] = [];
  let offset = 0;

  for (let i = 0; i < contract.lessonSceneTargets.length; i++) {
    const target = contract.lessonSceneTargets[i];
    const lessonOutlines = outlines.slice(offset, offset + target);
    offset += target;

    const parsedLesson = parsed.lessons?.[i];
    const first = lessonOutlines[0];
    const last = lessonOutlines[lessonOutlines.length - 1];

    lessons.push({
      title: parsedLesson?.title?.trim() || (first ? `Lesson ${i + 1}: ${first.title}` : `Lesson ${i + 1}`),
      objectives:
        parsedLesson?.objectives && parsedLesson.objectives.length > 0
          ? parsedLesson.objectives.slice(0, 2)
          : first
            ? [first.teachingObjective || first.description].filter(Boolean).slice(0, 2)
            : [],
      durationMinutes: Math.round(contract.durationMinutes / contract.lessonCount),
      sceneTarget: target,
      outlines: lessonOutlines,
    });
  }

  return lessons;
}

/**
 * Split assigned lessons into UnitBlueprints (Phase 2 §15.1): positionally
 * chunked by the contract's per-unit lesson counts. Model-provided unit
 * titles/objectives win; otherwise derived fallbacks are used. For a
 * single-unit contract the fallback unit title is the course title.
 */
export function splitIntoUnits(
  lessons: CourseBlueprint['lessons'],
  contract: CourseContract,
  parsed: ParsedOutlineResponse,
  courseTitle: string,
): UnitBlueprint[] {
  const units: UnitBlueprint[] = [];
  let offset = 0;

  for (let i = 0; i < contract.unitCount; i++) {
    const count = contract.unitLessonCounts[i];
    const unitLessons = lessons.slice(offset, offset + count);
    offset += count;

    const parsedUnit = parsed.units?.[i];
    const sceneTarget = unitLessons.reduce((sum, lesson) => sum + lesson.sceneTarget, 0);

    units.push({
      title:
        parsedUnit?.title?.trim() ||
        (contract.unitCount === 1 ? courseTitle : `Unit ${i + 1}: ${unitLessons[0]?.title ?? ''}`),
      objectives:
        parsedUnit?.objectives && parsedUnit.objectives.length > 0
          ? parsedUnit.objectives.slice(0, 2)
          : unitLessons[0]
            ? [unitLessons[0].objectives[0] || unitLessons[0].title]
            : [],
      durationMinutes: Math.round(contract.durationMinutes / Math.max(1, contract.unitCount)),
      sceneTarget,
      lessons: unitLessons,
    });
  }

  return units;
}

export function buildCourseBlueprint(
  parsed: ParsedOutlineResponse,
  requirement: string,
  contract: CourseContract,
  courseType: CourseType,
  fallbackTitle: string,
): CourseBlueprint {
  const languageDirective = parsed.languageDirective?.trim() || 'Teach in the language that matches the user requirement.';
  const rawTitle = parsed.courseTitle?.trim();
  const title = (rawTitle || fallbackTitle || requirement.slice(0, 30) || 'Course').slice(0, 30);

  const outlines = assignLessonIds(parsed.outlines ?? [], contract.lessonSceneTargets);
  // Phase 2 §15.4: stamp the derived depth level onto the blueprint and
  // every outline so the content stage can enforce the matching floor.
  const depthLevel: CourseDepthLevel = depthLevelForPreset(contract.sizePreset);
  const leveledOutlines = outlines.map((outline) => ({ ...outline, depthLevel }));
  const lessons = splitIntoLessons(leveledOutlines, contract, parsed);
  const units = splitIntoUnits(lessons, contract, parsed, title);

  return {
    title,
    languageDirective,
    durationMinutes: contract.durationMinutes,
    audience: parsed.audience?.trim() || 'General learners',
    objectives:
      parsed.objectives && parsed.objectives.length > 0
        ? parsed.objectives.filter((o) => typeof o === 'string' && o.trim()).slice(0, 5)
        : leveledOutlines.slice(0, 5).map((o) => o.description).filter(Boolean),
    courseType,
    lessonCount: contract.lessonCount,
    quizPlacement: contract.quizPlacement,
    sizePreset: contract.sizePreset,
    depthLevel,
    lessons,
    ...(contract.unitCount > 1 ? { units } : {}),
  };
}

// ==================== Validation ====================

export interface BlueprintValidationResult {
  valid: boolean;
  /** Hard failures — the blueprint must not be accepted. */
  errors: string[];
  /** Advisory findings (placement/caps) — feedback only. */
  warnings: string[];
}

export interface BlueprintValidationOptions {
  /**
   * Accept ±1 scene per lesson (final-exhaustion tolerance only). The
   * corrective loop absorbs misses with one feedback pass; ±1 is accepted
   * only when the loop is about to give up.
   */
  tolerance?: boolean;
  /** Legacy decks built before the contract (single lesson, any count). */
  legacy?: boolean;
}

function validateOutlineShape(outline: SceneOutline): string[] {
  const errors: string[] = [];
  if (!outline || typeof outline !== 'object') {
    errors.push('outline is not an object');
    return errors;
  }
  if (!outline.title || !outline.title.trim()) errors.push(`outline #${outline.order} missing title`);
  if (outline.type === 'quiz' && !outline.quizConfig) {
    errors.push(`quiz outline "${outline.title || outline.order}" missing quizConfig`);
  }
  if (outline.type === 'interactive' && !outline.interactiveConfig && !(outline.widgetType && outline.widgetOutline)) {
    errors.push(`interactive outline "${outline.title || outline.order}" missing widgetType/widgetOutline`);
  }
  if (outline.type === 'pbl' && !outline.pblConfig) {
    errors.push(`pbl outline "${outline.title || outline.order}" missing pblConfig`);
  }
  return errors;
}

/**
 * Validate a CourseBlueprint against the contract.
 * Structural + count failures are hard; placement findings are warnings.
 */
export function validateBlueprint(
  blueprint: CourseBlueprint,
  options: BlueprintValidationOptions = {},
): BlueprintValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (options.legacy) {
    if (!blueprint.title || !blueprint.title.trim()) errors.push('blueprint missing title');
    if (!blueprint.lessons || blueprint.lessons.length === 0) errors.push('blueprint has no lessons');
    for (const lesson of blueprint.lessons) {
      for (const outline of lesson.outlines) errors.push(...validateOutlineShape(outline));
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  if (!blueprint.title || !blueprint.title.trim()) errors.push('blueprint missing title');
  if (blueprint.title.length > 30) errors.push(`blueprint title exceeds 30 chars (${blueprint.title.length})`);
  if (!blueprint.languageDirective || !blueprint.languageDirective.trim()) {
    errors.push('blueprint missing languageDirective');
  }
  if (!Number.isFinite(blueprint.durationMinutes) || blueprint.durationMinutes <= 0) {
    errors.push('blueprint durationMinutes is not a positive number');
  }
  if (blueprint.objectives.length < 2 || blueprint.objectives.length > 5) {
    errors.push(`blueprint objectives must be 2-5, got ${blueprint.objectives.length}`);
  }
  if (blueprint.lessons.length === 0) {
    errors.push('blueprint has no lessons');
  } else {
    const blueprintPreset = resolveSizePreset(blueprint.sizePreset);
    const expectedLessonCount = deriveCourseContract(
      blueprint.durationMinutes,
      blueprint.courseType,
      blueprintPreset,
    ).lessonCount;
    if (blueprint.lessons.length !== expectedLessonCount) {
      errors.push(`lessonCount ${blueprint.lessons.length} does not match the derived split (${expectedLessonCount})`);
    }
  }

  let total = 0;
  const seenOrders = new Set<number>();
  const blueprintPreset = resolveSizePreset(blueprint.sizePreset);
  const presetConfig = COURSE_SIZE_PRESETS[blueprintPreset];
  const presetLessonCap = perLessonSceneCap(blueprintPreset);
  blueprint.lessons.forEach((lesson, lessonIndex) => {
    const target = lesson.sceneTarget;
    const count = lesson.outlines.length;
    total += count;

    if (lesson.objectives.length < 1 || lesson.objectives.length > 2) {
      warnings.push(`lesson ${lessonIndex + 1} has ${lesson.objectives.length} objectives (expected 1-2)`);
    }
    if (count < MIN_SCENES_PER_LESSON) {
      errors.push(`lesson ${lessonIndex + 1} has ${count} scenes, below the floor of ${MIN_SCENES_PER_LESSON}`);
    }
    if (count > presetLessonCap) {
      errors.push(`lesson ${lessonIndex + 1} has ${count} scenes, above the ${blueprintPreset} cap of ${presetLessonCap}`);
    }
    if (options.tolerance) {
      if (Math.abs(count - target) > 1) {
        errors.push(`lesson ${lessonIndex + 1} has ${count} scenes, target ${target} (±1 tolerance)`);
      }
    } else if (count !== target) {
      errors.push(`lesson ${lessonIndex + 1} has ${count} scenes, target ${target} (exact)`);
    }

    lesson.outlines.forEach((outline) => {
      errors.push(...validateOutlineShape(outline));
      if (outline.order == null) {
        errors.push(`outline "${outline.title || 'untitled'}" missing order`);
      } else if (seenOrders.has(outline.order)) {
        errors.push(`duplicate outline order ${outline.order}`);
      } else {
        seenOrders.add(outline.order);
      }
    });
  });

  if (total < MIN_SCENES) {
    errors.push(`course has ${total} scenes, below the floor of ${MIN_SCENES}`);
  }
  if (total > presetConfig.maxScenes) {
    errors.push(`course has ${total} scenes, above the ${blueprintPreset} cap of ${presetConfig.maxScenes}`);
  }

  // Unit structure (Phase 2 §15.1): when the contract derives more than one
  // unit, the blueprint must carry the unit level; otherwise the unit layer
  // must stay absent (single-unit shape).
  const expectedUnitCount = deriveCourseContract(
    blueprint.durationMinutes,
    blueprint.courseType,
    blueprintPreset,
  ).unitCount;
  if (expectedUnitCount > 1 && (!blueprint.units || blueprint.units.length === 0)) {
    errors.push(`course has ${expectedUnitCount} derived units but the unit structure is missing`);
  } else if (blueprint.units && blueprint.units.length > 0) {
    if (blueprint.units.length !== expectedUnitCount) {
      errors.push(`unit count ${blueprint.units.length} does not match the derived split (${expectedUnitCount})`);
    }
    let expectedLessonOffset = 0;
    blueprint.units.forEach((unit, unitIndex) => {
      if (!unit.title || !unit.title.trim()) {
        errors.push(`unit ${unitIndex + 1} missing title`);
      }
      const lessonCount = unit.lessons.length;
      const expectedLessons = contractLessonCountForUnit(blueprint, unitIndex);
      if (lessonCount !== expectedLessons) {
        errors.push(`unit ${unitIndex + 1} has ${lessonCount} lessons, expected ${expectedLessons}`);
      }
      const unitTarget = unit.lessons.reduce((sum, lesson) => sum + lesson.sceneTarget, 0);
      if (unit.sceneTarget !== unitTarget) {
        errors.push(`unit ${unitIndex + 1} sceneTarget ${unit.sceneTarget} does not match its lessons' sum (${unitTarget})`);
      }
      for (let i = 0; i < lessonCount; i++) {
        if (unit.lessons[i] !== blueprint.lessons[expectedLessonOffset + i]) {
          errors.push(`unit ${unitIndex + 1} lessons do not match the flat lessons projection`);
          break;
        }
      }
      expectedLessonOffset += lessonCount;
      if (unit.objectives.length < 1 || unit.objectives.length > 2) {
        warnings.push(`unit ${unitIndex + 1} has ${unit.objectives.length} objectives (expected 1-2)`);
      }
    });
  }

  // Placement advisories: quiz cadence + interactive/pbl caps.
  const quizCount = blueprint.lessons.flatMap((l) => l.outlines).filter((o) => o.type === 'quiz').length;
  const expectedQuizzes = Math.floor(total / blueprint.quizPlacement);
  if (quizCount < expectedQuizzes) {
    warnings.push(`quiz cadence: ${quizCount} quizzes vs ~${expectedQuizzes} expected (every ${blueprint.quizPlacement} scenes)`);
  }
  const interactiveCount = blueprint.lessons.flatMap((l) => l.outlines).filter((o) => o.type === 'interactive').length;
  if (interactiveCount > 2) {
    warnings.push(`interactive cap: ${interactiveCount} interactive scenes (max 2)`);
  }
  const pblCount = blueprint.lessons.flatMap((l) => l.outlines).filter((o) => o.type === 'pbl').length;
  if (pblCount > 1) {
    warnings.push(`pbl cap: ${pblCount} pbl scenes (max 1)`);
  }

  // Specialized scene advisories (Phase 2 §15.4b): at intermediate/university
  // depth the contract asks for per-unit glossary + further-reading and for
  // exercises on quantitative lessons. Warnings only — the deck still
  // validates without them, but the corrective loop passes the notes on.
  const depthLevel = blueprint.depthLevel ?? 'intro';
  if (depthLevel !== 'intro') {
    const outlines = blueprint.lessons.flatMap((l) => l.outlines);
    const unitCount = blueprint.units?.length ?? 1;
    const glossaryCount = outlines.filter((o) => o.type === 'glossary').length;
    if (glossaryCount < unitCount) {
      warnings.push(
        `specialized scenes: ${glossaryCount} glossary scene(s) for ${unitCount} unit(s) — include one key-term glossary per unit`,
      );
    }
    const readingCount = outlines.filter((o) => o.type === 'reading').length;
    if (readingCount < unitCount) {
      warnings.push(
        `specialized scenes: ${readingCount} reading scene(s) for ${unitCount} unit(s) — include one annotated further-reading scene per unit`,
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Expected lesson count for a unit in a validated blueprint: derive the
 * contract under the blueprint's preset and read the positional split.
 */
function contractLessonCountForUnit(blueprint: CourseBlueprint, unitIndex: number): number {
  const preset = resolveSizePreset(blueprint.sizePreset);
  const contract = deriveCourseContract(blueprint.durationMinutes, blueprint.courseType, preset);
  return contract.unitLessonCounts[unitIndex] ?? 0;
}

/**
 * Summarize a failed validation into corrective feedback appended to the
 * next attempt's prompt. Concrete findings, not a generic rejection.
 */
export function summarizeBlueprintValidation(result: BlueprintValidationResult): string {
  const lines: string[] = [];
  if (result.errors.length > 0) {
    lines.push('Your previous response did NOT meet the course contract:', ...result.errors.map((e) => `- ${e}`));
  }
  if (result.warnings.length > 0) {
    lines.push('Advisory notes:', ...result.warnings.map((w) => `- ${w}`));
  }
  lines.push('Fix the response to satisfy the contract exactly, and return the corrected JSON.');
  return lines.join('\n');
}

export { MAX_BLUEPRINT_ATTEMPTS };

/**
 * Validate the syllabus (structure-only) output of the multi-unit syllabus
 * stage (Phase 2 §15.8): unit count, per-unit lesson counts, and title
 * presence. Lesson counts are read from the unit entries (the syllabus
 * shape nests lessons under units; a redundant flat list is optional).
 * Concrete findings feed the bounded corrective loop.
 */
export function validateSyllabusStructure(
  parsed: ParsedOutlineResponse,
  contract: CourseContract,
): string[] {
  const errors: string[] = [];
  if (!parsed.units || parsed.units.length === 0) {
    errors.push(`syllabus must include ${contract.unitCount} units`);
    return errors;
  }
  if (parsed.units.length !== contract.unitCount) {
    errors.push(`syllabus has ${parsed.units.length} units, expected ${contract.unitCount}`);
  }
  const nestedLessons = parsed.units.flatMap((unit) => unit?.lessons ?? []);
  const lessonTotal = (parsed.lessons ?? nestedLessons).length;
  if (lessonTotal !== contract.lessonCount) {
    errors.push(`syllabus has ${lessonTotal} lessons, expected ${contract.lessonCount}`);
  }
  parsed.units.forEach((unit, unitIndex) => {
    if (!unit?.title?.trim()) errors.push(`unit ${unitIndex + 1} missing title`);
    const lessons = unit?.lessons ?? [];
    const expected = contract.unitLessonCounts[unitIndex] ?? 0;
    if (lessons.length !== expected) {
      errors.push(`unit ${unitIndex + 1} has ${lessons.length} lessons, expected ${expected}`);
    }
    lessons.forEach((lesson, lessonIndex) => {
      if (!lesson?.title?.trim()) {
        errors.push(`unit ${unitIndex + 1} lesson ${lessonIndex + 1} missing title`);
      }
    });
  });
  return errors;
}

/**
 * Render the syllabus contract block for the multi-unit syllabus stage
 * (Phase 2 §15.8): unit count and per-unit lesson counts only — the
 * syllabus call produces structure, never outlines.
 */
export function renderSyllabusContract(contract: CourseContract): string {
  const units = contract.unitLessonCounts
    .map((count, index) => `  Unit ${index + 1}: EXACTLY ${count} lessons.`)
    .join('\n');
  return `- Produce EXACTLY ${contract.unitCount} units (chapters) containing EXACTLY ${contract.lessonCount} lessons, in this order:\n${units}`;
}

/**
 * Scope the course-wide contract down to one unit (Phase 2 §15.8): the
 * unit's lesson targets. Per-unit outline calls render this instead of the
 * full contract, bounding each LLM call's output size; the caller keeps
 * global outline numbering via its own offset.
 */
export function buildPerUnitContract(base: CourseContract, unitIndex: number): CourseContract {
  const start = base.unitLessonCounts.slice(0, unitIndex).reduce((a, b) => a + b, 0);
  const count = base.unitLessonCounts[unitIndex];
  const lessonSceneTargets = base.lessonSceneTargets.slice(start, start + count);
  return {
    durationMinutes: base.durationMinutes,
    totalSceneTarget: lessonSceneTargets.reduce((a, b) => a + b, 0),
    lessonCount: count,
    lessonSceneTargets,
    unitCount: 1,
    unitLessonCounts: [count],
    quizPlacement: base.quizPlacement,
    sizePreset: base.sizePreset,
    depthLevel: base.depthLevel,
  };
}

// ==================== Legacy / job-model helpers ====================

/**
 * Wrap a legacy flat outline array into a single-lesson blueprint. Legacy
 * decks were built before the contract, so their counts are NOT validated
 * against it (validateBlueprint with `legacy: true`); the wrapper only
 * exists so old documents can carry the v2 shape.
 */
export function legacyBlueprintFromOutlines(
  outlines: SceneOutline[],
  title: string,
  languageDirective?: string,
): CourseBlueprint {
  const assigned = assignLessonIds(outlines, [Math.max(outlines.length, 1)]);
  const objectives = assigned.slice(0, 5).map((o) => o.description).filter(Boolean);
  return {
    title: (title || 'Legacy Course').slice(0, 30),
    languageDirective: languageDirective?.trim() || 'Teach in the language that matches the user requirement.',
    durationMinutes: DEFAULT_DURATION_MINUTES,
    audience: 'General learners',
    objectives: objectives.length >= 2 ? objectives : [...objectives, 'Apply the covered concepts'],
    courseType: 'explainer',
    lessonCount: 1,
    quizPlacement: QUIZ_PLACEMENT_DEFAULT,
    sizePreset: DEFAULT_SIZE_PRESET,
    depthLevel: 'intro' as const,
    lessons: [
      {
        title: `Lesson 1: ${title || 'Legacy Course'}`,
        objectives: objectives.length > 0 ? [objectives[0]] : [],
        durationMinutes: DEFAULT_DURATION_MINUTES,
        sceneTarget: assigned.length,
        outlines: assigned,
      },
    ],
  };
}
