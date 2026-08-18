/**
 * Stage 1: Generate scene outlines from user requirements.
 * Also contains outline fallback logic.
 */

import { nanoid } from 'nanoid';
import { MAX_PDF_CONTENT_CHARS, MAX_VISION_IMAGES } from '@/lib/constants/generation';
import type {
  UserRequirements,
  SceneOutline,
  PdfImage,
  ImageMapping,
  CourseBlueprint,
} from '@/lib/types/generation';
import {
  buildCourseBlueprint,
  deriveContractForRequest,
  inferCourseType,
  renderCourseContract,
  resolveRequestDuration,
  summarizeBlueprintValidation,
  validateBlueprint,
  MAX_BLUEPRINT_ATTEMPTS,
  type BlueprintValidationResult,
  type ParsedOutlineResponse,
} from './blueprint';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import { formatImageDescription, formatImagePlaceholder } from './prompt-formatters';
import { sortDocumentImagesForVision } from '@/lib/document/bundle';
import { parseJsonResponse } from './json-repair';
import { uniquifyMediaElementIds } from './scene-builder';
import type { AICallFn, GenerationResult } from './pipeline-types';
import { createLogger } from '@/lib/logger';
const log = createLogger('Generation');

/**
 * Used when the outline stage fails to produce an explicit directive (LLM
 * schema regression, empty response, upstream error). Downstream prompts
 * still need *something* that steers the model toward the requirement's
 * language rather than defaulting to the training-distribution prior.
 */
export const DEFAULT_LANGUAGE_DIRECTIVE =
  'Teach in the language that matches the user requirement.';

/**
 * Generate scene outlines from user requirements
 * Now uses simplified UserRequirements with just requirement text and language
 *
 * The output is a validated `CourseBlueprint`: the course-wide scene total
 * and per-lesson targets are derived from the resolved duration and the
 * parsed outlines must satisfy the contract exactly. A bounded corrective
 * loop re-prompts with concrete findings; on exhaustion the run fails with
 * the validation report — a thin deck is never accepted as valid output.
 *
 * `data` carries the blueprint plus legacy flattened fields
 * (`languageDirective` / `courseTitle` / `outlines`) so existing callers
 * keep working while migrating to `blueprint`.
 */
export async function generateSceneOutlinesFromRequirements(
  requirements: UserRequirements,
  pdfText: string | undefined,
  pdfImages: PdfImage[] | undefined,
  aiCall: AICallFn,
  options?: {
    visionEnabled?: boolean;
    imageMapping?: ImageMapping;
    imageGenerationEnabled?: boolean;
    videoGenerationEnabled?: boolean;
    researchContext?: string;
    teacherContext?: string;
    /** Typed duration input (minutes). Falls back to text-parse, then default. */
    durationMinutes?: number;
    /** Size preset ('compact' | 'standard' | 'intensive' | 'semester'). */
    sizePreset?: unknown;
  },
): Promise<
  GenerationResult<{
    blueprint: CourseBlueprint;
    languageDirective: string;
    courseTitle?: string;
    outlines: SceneOutline[];
  }>
> {
  // Resolve the course contract BEFORE the prompt: duration (typed input →
  // requirement text → preset default) and course flavor from the
  // requirement. The size preset sets the caps either way.
  const courseType = inferCourseType(requirements.requirement);
  const requestDuration = resolveRequestDuration(
    options?.sizePreset,
    options?.durationMinutes,
    requirements.requirement,
  );
  const contract = deriveContractForRequest(
    options?.sizePreset,
    courseType,
    requestDuration.minutes,
  );
  const courseContract = renderCourseContract(contract, courseType);

  // Build available images description for the prompt
  let availableImagesText = 'No images available';
  let visionImages: Array<{ id: string; src: string }> | undefined;

  if (pdfImages && pdfImages.length > 0) {
    if (options?.visionEnabled && options?.imageMapping) {
      // Vision mode: split into vision images (first N) and text-only (rest)
      const sortedImages = sortDocumentImagesForVision(pdfImages);
      const allWithSrc = sortedImages.filter((img) => options.imageMapping![img.id]);
      const visionSlice = allWithSrc.slice(0, MAX_VISION_IMAGES);
      const textOnlySlice = allWithSrc.slice(MAX_VISION_IMAGES);
      const noSrcImages = sortedImages.filter((img) => !options.imageMapping![img.id]);

      const visionDescriptions = visionSlice.map((img) => formatImagePlaceholder(img));
      const textDescriptions = [...textOnlySlice, ...noSrcImages].map((img) =>
        formatImageDescription(img),
      );
      availableImagesText = [...visionDescriptions, ...textDescriptions].join('\n');

      visionImages = visionSlice.map((img) => ({
        id: img.id,
        src: options.imageMapping![img.id],
        width: img.width,
        height: img.height,
      }));
    } else {
      // Text-only mode: full descriptions
      availableImagesText = pdfImages.map((img) => formatImageDescription(img)).join('\n');
    }
  }

  // Build user profile string for prompt injection
  const userProfileText =
    requirements.userNickname || requirements.userBio
      ? `## Student Profile\n\nStudent: ${requirements.userNickname || 'Unknown'}${requirements.userBio ? ` — ${requirements.userBio}` : ''}\n\nConsider this student's background when designing the course. Adapt difficulty, examples, and teaching approach accordingly.\n\n---`
      : '';

  // Build media snippet conditions based on enabled flags.
  const imageEnabled = options?.imageGenerationEnabled ?? false;
  const videoEnabled = options?.videoGenerationEnabled ?? false;
  const mediaEnabled = imageEnabled || videoEnabled;
  const hasSourceImages = (pdfImages?.length ?? 0) > 0;

  // Use simplified prompt variables
  const baseVariables = {
    // New simplified variables
    requirement: requirements.requirement,
    pdfContent: pdfText ? pdfText.substring(0, MAX_PDF_CONTENT_CHARS) : 'None',
    availableImages: availableImagesText,
    userProfile: userProfileText,
    hasSourceImages,
    imageEnabled,
    videoEnabled,
    mediaEnabled,
    researchContext: options?.researchContext || 'None',
    // Server-side generation populates this via options; client-side populates via formatTeacherPersonaForPrompt
    teacherContext: options?.teacherContext || '',
    courseContract,
    resolvedDurationMinutes: contract.durationMinutes,
  };

  let feedback: string | undefined;
  let lastBlueprint: CourseBlueprint | undefined;
  let lastReport: BlueprintValidationResult | undefined;

  for (let attempt = 1; attempt <= MAX_BLUEPRINT_ATTEMPTS; attempt++) {
    const prompts = buildPrompt(PROMPT_IDS.REQUIREMENTS_TO_OUTLINES, baseVariables);
    if (!prompts) {
      return { success: false, error: 'Prompt template not found' };
    }
    const userPrompt = feedback ? `${prompts.user}\n\n## Correction Required\n\n${feedback}` : prompts.user;

    try {
      const response = await aiCall(prompts.system, userPrompt, visionImages);
      const parsed = parseJsonResponse<ParsedOutlineResponse | SceneOutline[]>(response);

      let languageDirective: string;
      let courseTitle: string | undefined;
      let rawOutlines: SceneOutline[];
      let audience: string | undefined;
      let courseObjectives: string[] | undefined;
      let lessons: ParsedOutlineResponse['lessons'];
      let units: ParsedOutlineResponse['units'];

      if (Array.isArray(parsed)) {
        // Fallback: LLM returned old flat array format
        languageDirective = DEFAULT_LANGUAGE_DIRECTIVE;
        rawOutlines = parsed;
      } else if (parsed && parsed.outlines) {
        languageDirective = parsed.languageDirective || DEFAULT_LANGUAGE_DIRECTIVE;
        // courseTitle is optional — only honor a non-empty string, and cap its
        // length defensively (the prompt asks for ≤30 chars, but older/hallucinating
        // models may return far more). The downstream Stage.name column is bounded too.
        const rawTitle = parsed.courseTitle;
        courseTitle =
          typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim().slice(0, 120) : undefined;
        rawOutlines = parsed.outlines;
        audience = parsed.audience;
        courseObjectives = parsed.objectives;
        lessons = parsed.lessons;
        units = parsed.units;
      } else {
        return { success: false, error: 'Failed to parse scene outlines response' };
      }

      if (!Array.isArray(rawOutlines)) {
        return { success: false, error: 'Failed to parse scene outlines response' };
      }

      // Ensure IDs and order
      const enriched = rawOutlines.map((outline, index) => ({
        ...outline,
        id: outline.id || nanoid(),
        order: index + 1,
      }));

      // Replace sequential gen_img_N/gen_vid_N with globally unique IDs
      const result = uniquifyMediaElementIds(enriched);

      const blueprint = buildCourseBlueprint(
        {
          languageDirective,
          courseTitle,
          outlines: result,
          audience,
          objectives: courseObjectives,
          lessons,
          units,
        },
        requirements.requirement,
        contract,
        courseType,
        courseTitle ?? requirements.requirement.slice(0, 30),
      );

      const report = validateBlueprint(blueprint, { tolerance: attempt === MAX_BLUEPRINT_ATTEMPTS });
      lastBlueprint = blueprint;
      lastReport = report;

      if (report.valid) {
        return {
          success: true,
          data: {
            blueprint,
            languageDirective: blueprint.languageDirective,
            courseTitle,
            outlines: blueprint.lessons.flatMap((lesson) => lesson.outlines),
          },
        };
      }

      feedback = summarizeBlueprintValidation(report);
      log.warn(
        `Blueprint contract not met (attempt ${attempt}/${MAX_BLUEPRINT_ATTEMPTS}): ${report.errors.length} error(s), ${report.warnings.length} warning(s)`,
      );
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  // Exhausted the corrective budget: never accept a broken deck. Surface the
  // last parse's validation report so the caller can show concrete findings.
  return {
    success: false,
    error: 'Scene outline generation did not meet the course contract',
    validation: lastReport,
  };
}

/**
 * Apply type fallbacks for outlines that can't be generated as their declared type.
 * - interactive without interactiveConfig OR widgetType+widgetOutline → slide
 * - pbl without pblConfig or languageModel → slide
 */
export function sanitizeProceduralSkillOutline(outline: SceneOutline): SceneOutline {
  const widgetOutline = { ...(outline.widgetOutline ?? {}) };
  delete widgetOutline.procedureType;
  delete widgetOutline.task;
  delete widgetOutline.tools;
  delete widgetOutline.steps;
  delete widgetOutline.successCriteria;
  delete widgetOutline.errorConsequences;

  return {
    ...outline,
    type: 'interactive',
    widgetType: 'diagram',
    description: outline.description
      ? `${outline.description} Present this as a process or structure diagram.`
      : 'Present this topic as a process or structure diagram.',
    widgetOutline,
  };
}

export function applyOutlineFallbacks(
  outline: SceneOutline,
  hasLanguageModel: boolean,
  options: { allowProceduralSkill?: boolean } = {},
): SceneOutline {
  // Ultra Mode: interactive scenes with widgetType + widgetOutline are valid
  const hasWidgetConfig = outline.widgetType && outline.widgetOutline;

  if (outline.widgetType === 'procedural-skill' && !options.allowProceduralSkill) {
    log.warn(`Procedural-skill outline "${outline.title}" is not enabled, falling back to diagram`);
    return sanitizeProceduralSkillOutline(outline);
  }

  if (outline.type === 'interactive' && !outline.interactiveConfig && !hasWidgetConfig) {
    log.warn(
      `Interactive outline "${outline.title}" missing interactiveConfig and widget config, falling back to slide`,
    );
    return { ...outline, type: 'slide' };
  }
  if (outline.type === 'pbl' && (!outline.pblConfig || !hasLanguageModel)) {
    log.warn(
      `PBL outline "${outline.title}" missing pblConfig or languageModel, falling back to slide`,
    );
    return { ...outline, type: 'slide' };
  }
  return outline;
}
