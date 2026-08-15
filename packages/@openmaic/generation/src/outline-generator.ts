/**
 * Stage 1: Generate scene outlines from user requirements.
 * Also contains outline fallback logic.
 */

import { nanoid } from 'nanoid';
import {
  DEFAULT_DURATION_MINUTES,
  MAX_BLUEPRINT_ATTEMPTS,
  MAX_PDF_CONTENT_CHARS,
  MAX_VISION_IMAGES,
} from './constants.js';
import {
  buildCourseBlueprint,
  deriveContractForRequest,
  inferCourseType,
  parseDurationFromText,
  renderCourseContract,
  summarizeBlueprintValidation,
  validateBlueprint,
  type BlueprintValidationResult,
  type CourseBlueprint,
  type CourseContract,
  type ParsedOutlineResponse,
} from './blueprint.js';
import { parseJsonResponse } from './json-repair.js';
import { noopGenerationLogger, type GenerationLogger } from './logger.js';
import {
  formatImageDescription,
  formatImagePlaceholder,
  sortDocumentImagesForVision,
} from './outline-formatters.js';
import { uniquifyMediaElementIds } from './outline-media.js';
import type { ImageMapping, PdfImage, SceneOutline, UserRequirements } from './outline-types.js';
import type { AICallFn, GenerationResult } from './pipeline-types.js';
import { buildPrompt, PROMPT_IDS } from './prompts/index.js';

export const DEFAULT_LANGUAGE_DIRECTIVE =
  'Teach in the language that matches the user requirement.';

export interface OutlinePromptContext {
  pdfText?: string;
  pdfImages?: PdfImage[];
  visionEnabled?: boolean;
  imageMapping?: ImageMapping;
  imageGenerationEnabled?: boolean;
  videoGenerationEnabled?: boolean;
  researchContext?: string;
  teacherContext?: string;
  /** Rendered course contract block (blueprint Pillar 1). Empty when unset. */
  courseContract?: string;
  /** Resolved course duration in minutes (drives the contract's scene math). */
  resolvedDurationMinutes?: number;
}

export interface OutlineGenerationOptions extends Omit<
  OutlinePromptContext,
  'pdfText' | 'pdfImages'
> {
  logger?: GenerationLogger;
  /** Typed duration input (minutes). Falls back to text-parse, then default. */
  durationMinutes?: number;
  /** Size preset ('compact' | 'standard' | 'intensive' | 'semester'). */
  sizePreset?: unknown;
}

export interface OutlineFallbackOptions {
  allowProceduralSkill?: boolean;
  logger?: GenerationLogger;
}

function buildAvailableImages(
  pdfImages: PdfImage[] | undefined,
  context: OutlinePromptContext,
): { availableImagesText: string; visionImages?: Array<{ id: string; src: string }> } {
  let availableImagesText = 'No images available';
  let visionImages: Array<{ id: string; src: string }> | undefined;

  if (pdfImages && pdfImages.length > 0) {
    if (context.visionEnabled && context.imageMapping) {
      const sortedImages = sortDocumentImagesForVision(pdfImages);
      const allWithSrc = sortedImages.filter((image) => context.imageMapping![image.id]);
      const visionSlice = allWithSrc.slice(0, MAX_VISION_IMAGES);
      const textOnlySlice = allWithSrc.slice(MAX_VISION_IMAGES);
      const noSrcImages = sortedImages.filter((image) => !context.imageMapping![image.id]);

      const visionDescriptions = visionSlice.map((image) => formatImagePlaceholder(image));
      const textDescriptions = [...textOnlySlice, ...noSrcImages].map((image) =>
        formatImageDescription(image),
      );
      availableImagesText = [...visionDescriptions, ...textDescriptions].join('\n');

      visionImages = visionSlice.map((image) => ({
        id: image.id,
        src: context.imageMapping![image.id],
        width: image.width,
        height: image.height,
      }));
    } else {
      availableImagesText = pdfImages.map((image) => formatImageDescription(image)).join('\n');
    }
  }

  return { availableImagesText, visionImages };
}

/** Build the byte-stable system and user prompts for outline generation. */
export function buildOutlinePrompt(
  requirements: UserRequirements,
  context: OutlinePromptContext = {},
): { system: string; user: string } {
  const { pdfText, pdfImages } = context;
  const { availableImagesText } = buildAvailableImages(pdfImages, context);

  const userProfileText =
    requirements.userNickname || requirements.userBio
      ? `## Student Profile\n\nStudent: ${requirements.userNickname || 'Unknown'}${requirements.userBio ? ` — ${requirements.userBio}` : ''}\n\nConsider this student's background when designing the course. Adapt difficulty, examples, and teaching approach accordingly.\n\n---`
      : '';

  const imageEnabled = context.imageGenerationEnabled ?? false;
  const videoEnabled = context.videoGenerationEnabled ?? false;
  const mediaEnabled = imageEnabled || videoEnabled;
  const hasSourceImages = (pdfImages?.length ?? 0) > 0;

  const prompts = buildPrompt(PROMPT_IDS.REQUIREMENTS_TO_OUTLINES, {
    requirement: requirements.requirement,
    pdfContent: pdfText ? pdfText.substring(0, MAX_PDF_CONTENT_CHARS) : 'None',
    availableImages: availableImagesText,
    userProfile: userProfileText,
    hasSourceImages,
    imageEnabled,
    videoEnabled,
    mediaEnabled,
    researchContext: context.researchContext || 'None',
    teacherContext: context.teacherContext || '',
    courseContract: context.courseContract || '',
    resolvedDurationMinutes: context.resolvedDurationMinutes ?? DEFAULT_DURATION_MINUTES,
  });

  if (!prompts) {
    throw new Error('Prompt template not found');
  }

  return prompts;
}

/**
 * Generate scene outlines from user requirements.
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
  options?: OutlineGenerationOptions,
): Promise<
  GenerationResult<{
    blueprint: CourseBlueprint;
    languageDirective: string;
    courseTitle?: string;
    outlines: SceneOutline[];
  }>
> {
  const logger = options?.logger ?? noopGenerationLogger;
  const context: OutlinePromptContext = { ...options, pdfText, pdfImages };

  // Resolve the course contract BEFORE the prompt: duration (typed input →
  // requirement text → preset default) and course flavor from the
  // requirement. The size preset sets the caps either way.
  const courseType = inferCourseType(requirements.requirement);
  const contract: CourseContract = deriveContractForRequest(
    options?.sizePreset,
    courseType,
    options?.durationMinutes ?? parseDurationFromText(requirements.requirement) ?? undefined,
  );
  const courseContract = renderCourseContract(contract, courseType);

  const { visionImages } = buildAvailableImages(pdfImages, context);

  // Build user profile string for prompt injection
  const userProfileText =
    requirements.userNickname || requirements.userBio
      ? `## Student Profile\n\nStudent: ${requirements.userNickname || 'Unknown'}${requirements.userBio ? ` - ${requirements.userBio}` : ''}\n\nConsider this student's background when designing the course. Adapt difficulty, examples, and teaching approach accordingly.\n\n---`
      : '';

  const baseVariables = {
    requirement: requirements.requirement,
    pdfContent: pdfText ? pdfText.substring(0, MAX_PDF_CONTENT_CHARS) : 'None',
    availableImages: buildAvailableImages(pdfImages, context).availableImagesText,
    userProfile: userProfileText,
    hasSourceImages: (pdfImages?.length ?? 0) > 0,
    imageEnabled: options?.imageGenerationEnabled ?? false,
    videoEnabled: options?.videoGenerationEnabled ?? false,
    mediaEnabled:
      (options?.imageGenerationEnabled ?? false) || (options?.videoGenerationEnabled ?? false),
    researchContext: options?.researchContext || 'None',
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
    const userPrompt = feedback
      ? `${prompts.user}\n\n## Correction Required\n\n${feedback}`
      : prompts.user;

    try {
      const response = await aiCall(prompts.system, userPrompt, visionImages);
      const parsed = parseJsonResponse<ParsedOutlineResponse | SceneOutline[]>(response, {
        logger,
      });

      let languageDirective: string;
      let courseTitle: string | undefined;
      let rawOutlines: SceneOutline[];
      let audience: string | undefined;
      let courseObjectives: string[] | undefined;
      let lessons: ParsedOutlineResponse['lessons'];

      if (Array.isArray(parsed)) {
        // Fallback: LLM returned old flat array format
        languageDirective = DEFAULT_LANGUAGE_DIRECTIVE;
        rawOutlines = parsed;
      } else if (parsed && parsed.outlines) {
        languageDirective = parsed.languageDirective || DEFAULT_LANGUAGE_DIRECTIVE;
        // courseTitle is optional - only honor a non-empty string, and cap its
        // length defensively (the prompt asks for ≤30 chars, but older/hallucinating
        // models may return far more). The downstream Stage.name column is bounded too.
        const rawTitle = parsed.courseTitle;
        courseTitle =
          typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim().slice(0, 120) : undefined;
        rawOutlines = parsed.outlines;
        audience = parsed.audience;
        courseObjectives = parsed.objectives;
        lessons = parsed.lessons;
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
      logger.warn(
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
  options: OutlineFallbackOptions = {},
): SceneOutline {
  const logger = options.logger ?? noopGenerationLogger;
  const hasWidgetConfig = outline.widgetType && outline.widgetOutline;

  if (outline.widgetType === 'procedural-skill' && !options.allowProceduralSkill) {
    logger.warn(
      `Procedural-skill outline "${outline.title}" is not enabled, falling back to diagram`,
    );
    return sanitizeProceduralSkillOutline(outline);
  }

  if (outline.type === 'interactive' && !outline.interactiveConfig && !hasWidgetConfig) {
    logger.warn(
      `Interactive outline "${outline.title}" missing interactiveConfig and widget config, falling back to slide`,
    );
    return { ...outline, type: 'slide' };
  }
  if (outline.type === 'pbl' && (!outline.pblConfig || !hasLanguageModel)) {
    logger.warn(
      `PBL outline "${outline.title}" missing pblConfig or languageModel, falling back to slide`,
    );
    return { ...outline, type: 'slide' };
  }
  return outline;
}
