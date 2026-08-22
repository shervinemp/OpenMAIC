/**
 * Scene Outlines Streaming API (SSE)
 *
 * Streams outline generation via Server-Sent Events.
 * Emits individual outline objects as they're parsed from the LLM response,
 * so the frontend can display them incrementally.
 *
 * SSE events:
 *   { type: 'languageDirective', data: string }
 *   { type: 'courseTitle', data: string }
 *   { type: 'outline', data: SceneOutline, index: number }
 *   { type: 'done', outlines: SceneOutline[], languageDirective: string, courseTitle?: string }
 *   { type: 'error', error: string }
 */

import { NextRequest } from 'next/server';
import { streamLLM, callLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import {
  formatImageDescription,
  formatImagePlaceholder,
  buildVisionUserContent,
  uniquifyMediaElementIds,
  formatTeacherPersonaForPrompt,
} from '@/lib/generation/generation-pipeline';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import { DEFAULT_LANGUAGE_DIRECTIVE } from '@/lib/generation/outline-generator';
import {
  LLM_CALL_CONCURRENCY,
  MAX_PDF_CONTENT_CHARS,
  MAX_VISION_IMAGES,
} from '@/lib/constants/generation';
import { nanoid } from 'nanoid';
import type {
  UserRequirements,
  PdfImage,
  SceneOutline,
  ImageMapping,
} from '@/lib/types/generation';
import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { resolveModel, resolveModelFromRequest } from '@/lib/server/resolve-model';
import { sortDocumentImagesForVision } from '@/lib/document/bundle';
import { resolveOutlineReviewMode, resolveVocationalActive } from '@/lib/config/feature-flags';
import {
  buildCourseBlueprint,
  clampDurationMinutes,
  deriveContractForRequest,
  inferCourseType,
  parseDurationFromText,
  renderCourseContract,
  renderLessonScopedContract,
  renderSyllabusContract,
  resolveRequestDuration,
  summarizeBlueprintValidation,
  validateBlueprint,
  validateOutlineShape,
  validateSyllabusStructure,
  MAX_BLUEPRINT_ATTEMPTS,
  type CourseContract,
  type ParsedOutlineResponse,
} from '@/lib/generation/blueprint';
import { parseJsonResponse } from '@/lib/generation/json-repair';
import { searchWeb, formatSearchResultsAsContext } from '@/lib/web-search';
import {
  formatWebSourceLegend,
  webSourcesToChunks,
} from '@/lib/generation/web-retrieval';
import {
  renderDocumentDigest,
  type DocumentDigest,
} from '@/lib/generation/document-digest';
import {
  auditDigestCoverage,
  collectCitedMarkers,
  renderCoverageReport,
} from '@/lib/generation/coverage-audit';
import { loadDocumentIndex } from '@/lib/server/document-index-store';
import { DIGEST_TARGET_CHARS } from '@/lib/constants/generation';
import type { WebSearchProviderId, BaiduSubSources } from '@/lib/web-search/types';
import { DEFAULT_DURATION_MINUTES } from '@/lib/constants/generation';
import {
  chunkSourceText,
  formatRetrievalContext,
  retrieveChunks,
  type PdfChunk,
} from '@/lib/generation/pdf-retrieval';
import { lazyBoundedMap } from '@/lib/utils/concurrency';
import {
  buildUnitReviewSummary,
  summarizeUnitReviewFindings,
  validateUnitReviewVerdict,
  type UnitReviewVerdict,
} from '@/lib/generation/unit-review';
import type { CourseBlueprint } from '@/lib/types/generation';
const log = createLogger('Outlines Stream');

export const maxDuration = 300;

/**
 * Extract the languageDirective from the streamed wrapper JSON.
 * Matches `"languageDirective":"<value>"` in partial JSON like:
 *   {"languageDirective":"τö¿Σ╕¡µûçµÄêΦ»╛...","outlines":[...
 */
function extractLanguageDirective(buffer: string): string | null {
  // The directive is the first key of the wrapper object, so it can only ever
  // appear in the head of the buffer. Bound the scan to keep this O(1) per
  // streamed chunk ΓÇö it is called on the full, growing buffer on every chunk,
  // which is otherwise O(n┬▓) over the stream.
  const head = buffer.length > 8192 ? buffer.slice(0, 8192) : buffer;
  const match = head.match(/"languageDirective"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

/**
 * Extract the courseTitle from the streamed wrapper JSON.
 * Same head-bound scan as `extractLanguageDirective` ΓÇö the title is a
 * top-level key near the start of the wrapper object, so it only appears in
 * the buffer head. Returns the decoded title, or null if not yet streamed.
 */
const COURSE_TITLE_RE = /"courseTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/;

// Normalize a captured title identically to the non-streaming parser
// (lib/generation/outline-generator.ts): ignore whitespace-only titles and cap
// length defensively so a hallucinating model cannot push a blank or unbounded
// value into the stage name. Returning null lets callers fall back / keep scanning.
function normalizeStreamedTitle(raw: string): string | null {
  let title: string;
  try {
    title = JSON.parse(`"${raw}"`);
  } catch {
    title = raw;
  }
  const normalized = title.trim();
  return normalized ? normalized.slice(0, 120) : null;
}

function extractCourseTitle(buffer: string): string | null {
  const head = buffer.length > 8192 ? buffer.slice(0, 8192) : buffer;
  const match = head.match(COURSE_TITLE_RE);
  return match ? normalizeStreamedTitle(match[1]) : null;
}

/**
 * Full-buffer fallback, run once after the stream completes: recovers a title
 * the model emitted after the `outlines` array or beyond the 8KB head window ΓÇö
 * cases the head-bound `extractCourseTitle` scan would miss. Only invoked when
 * the streaming scan produced nothing, so the extra full-buffer regex is paid once.
 */
function extractCourseTitleFromComplete(buffer: string): string | null {
  const match = buffer.match(COURSE_TITLE_RE);
  return match ? normalizeStreamedTitle(match[1]) : null;
}

/**
 * Recover the optional wrapper metadata (`lessons`, `units`, `audience`,
 * `objectives`) from the completed stream. The incremental parser only
 * handles the `outlines` array, so a single full-buffer JSON.parse is paid
 * once at completion ΓÇö the model emits a conforming wrapper per the prompt
 * contract, and any failure falls back to derived values.
 */
function extractWrapperMeta(buffer: string): Partial<ParsedOutlineResponse> | null {
  try {
    const parsed = JSON.parse(buffer) as ParsedOutlineResponse;
    return {
      lessons: parsed.lessons,
      units: parsed.units,
      audience: parsed.audience,
      objectives: parsed.objectives,
    };
  } catch {
    return null;
  }
}

/**
 * Incremental JSON array parser.
 * Extracts complete top-level objects from a partially-streamed JSON array,
 * resuming from `scanFrom` (an index into `buffer`) so the growing buffer is
 * scanned only ONCE across the whole stream ΓÇö O(n) total instead of O(n┬▓).
 * Supports both a flat array `[{...},{...}]` and a wrapper object
 * `{"languageDirective":"...","outlines":[{...},{...}]}`, with or without a
 * markdown ```json fence (the array is located by content, not by stripping).
 * Returns newly found objects plus the index to resume scanning from next time.
 */
function extractNewOutlines(
  buffer: string,
  scanFrom: number,
): { outlines: SceneOutline[]; scanFrom: number } {
  const results: SceneOutline[] = [];

  let i: number;
  if (scanFrom > 0) {
    // Resume just past the last fully-parsed object (between array elements,
    // so not inside a string and at brace depth 0).
    i = scanFrom;
  } else {
    // Locate the outlines array opening once.
    const outlinesKeyIdx = buffer.indexOf('"outlines"');
    const arrayStart =
      outlinesKeyIdx >= 0 ? buffer.indexOf('[', outlinesKeyIdx) : buffer.indexOf('[');
    if (arrayStart === -1) return { outlines: results, scanFrom: 0 };
    i = arrayStart + 1;
  }

  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;
  let consumed = i; // index just past the last fully-parsed object

  for (; i < buffer.length; i++) {
    const char = buffer[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        try {
          results.push(JSON.parse(buffer.substring(objectStart, i + 1)));
        } catch {
          // Incomplete or invalid JSON ΓÇö skip
        }
        objectStart = -1;
        consumed = i + 1;
      }
    }
  }

  return { outlines: results, scanFrom: consumed };
}

function normalizeTaskEngineProceduralOutline(
  outline: SceneOutline,
  requirement: string,
): SceneOutline {
  const widgetOutline = outline.widgetOutline ?? {};

  return {
    ...outline,
    type: 'interactive',
    widgetType: 'procedural-skill',
    widgetOutline: {
      ...widgetOutline,
      procedureType: widgetOutline.procedureType ?? 'inspection',
      task: widgetOutline.task || requirement,
      tools:
        widgetOutline.tools && widgetOutline.tools.length > 0
          ? widgetOutline.tools
          : ['required PPE', 'task checklist'],
      steps:
        widgetOutline.steps && widgetOutline.steps.length > 0
          ? widgetOutline.steps
          : ['Confirm task conditions', 'Select required tools', 'Complete safety check'],
      successCriteria:
        widgetOutline.successCriteria && widgetOutline.successCriteria.length > 0
          ? widgetOutline.successCriteria
          : ['Required checks completed', 'Unsafe conditions are not ignored'],
      errorConsequences:
        widgetOutline.errorConsequences && widgetOutline.errorConsequences.length > 0
          ? widgetOutline.errorConsequences
          : ['Unsafe or incorrect actions require stopping and rechecking'],
    },
  };
}

function normalizeTaskEngineSlideOutline(outline: SceneOutline): SceneOutline {
  const normalized: SceneOutline = {
    ...outline,
    type: 'slide',
  };
  delete normalized.widgetType;
  delete normalized.widgetOutline;
  delete normalized.interactiveConfig;
  return normalized;
}

const ORDINARY_WIDGET_TYPES = new Set(['simulation', 'diagram', 'code', 'game', 'visualization3d']);

function normalizeTaskEngineOutline(outline: SceneOutline, requirement: string): SceneOutline {
  if (outline.type === 'slide') {
    return normalizeTaskEngineSlideOutline(outline);
  }

  if (outline.type === 'interactive' && outline.widgetType === 'procedural-skill') {
    return normalizeTaskEngineProceduralOutline(outline, requirement);
  }

  if (
    outline.type === 'interactive' &&
    outline.widgetType &&
    ORDINARY_WIDGET_TYPES.has(outline.widgetType)
  ) {
    return outline;
  }

  return normalizeTaskEngineSlideOutline(outline);
}

function sanitizeNonTaskEngineOutline(outline: SceneOutline): SceneOutline {
  if (outline.widgetType !== 'procedural-skill') {
    return outline;
  }

  const widgetOutline = { ...(outline.widgetOutline ?? {}) };
  delete widgetOutline.procedureType;
  delete widgetOutline.task;
  delete widgetOutline.tools;
  delete widgetOutline.steps;
  delete widgetOutline.successCriteria;
  delete widgetOutline.errorConsequences;

  // procedural-skill is gated behind taskEngineMode to protect ordinary MAIC generation.
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

function ensureUniqueOutlineId(outline: SceneOutline, usedIds: Set<string>): SceneOutline {
  const candidate = typeof outline.id === 'string' && outline.id.trim() ? outline.id : undefined;
  if (candidate && !usedIds.has(candidate)) {
    usedIds.add(candidate);
    return outline;
  }

  let id = nanoid();
  while (usedIds.has(id)) {
    id = nanoid();
  }
  usedIds.add(id);
  return { ...outline, id };
}

// ==================== Multi-unit outline generation (Phase 2 §15.8) ====================
// For contracts deriving more than one unit, the outline stage splits into a
// bounded syllabus call (structure only) followed by one outline call per
// unit, each with its own corrective loop. Each LLM call stays small even
// for semester-scale courses; the assembled deck still passes the full
// blueprint validation exactly.

interface MultiUnitOutlineRun {
  requirement: string;
  promptId: string;
  /** Prompt variables shared with the single-call path. */
  baseVariables: Record<string, unknown>;
  /** Global research context from the client's web-search step (may be empty). */
  researchContext: string;
  /** Per-unit web research config (Phase 2 §15.2); absent = no unit research. */
  webSearchConfig?: {
    providerId?: string;
    apiKey?: string;
    baseUrl?: string;
    baiduSubSources?: BaiduSubSources;
  };
  courseContract: CourseContract;
  courseType: CourseBlueprint['courseType'];
  callModel: (params: { system: string; user: string }) => Promise<string>;
  /**
   * Optional judge model for the review gate. When set, the review deck is
   * judged by this model instead of the generator (which would otherwise
   * grade its own output — a systematic blind spot).
   */
  reviewCallModel?: (params: { system: string; user: string }) => Promise<string>;
  signal: AbortSignal | undefined;
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  /** Resume checkpoint from a prior partial run (§16 recovery). */
  resumeSyllabus?: ParsedOutlineResponse;
  resumeOutlines?: SceneOutline[];
  resumeFromUnitIndex?: number;
}

interface MultiUnitOutlineResult {
  blueprint: CourseBlueprint;
  outlines: SceneOutline[];
  languageDirective: string | null;
  courseTitle: string | null;
}

/** One lesson scheduled for per-lesson outline generation (Phase 2 §15.8). */
interface PendingLesson {
  /** Global lesson index (0-based, across all units). */
  lessonIndex: number;
  unitIndex: number;
  lessonIndexInUnit: number;
  unit: {
    title?: string;
    objectives?: string[];
    lessons?: Array<{ title?: string; objectives?: string[] }>;
  };
  lesson: { title?: string; objectives?: string[] };
}

/**
 * Phase 2 §15.5 — the outline review gate. Runs an LLM-as-judge verdict on a
 * deck (a unit or — since the per-lesson rework — a single lesson) against
 * that deck's objectives.
 *
 * Returns null when the deck is ACCEPTED: the verdict was adequate, the judge
 * infrastructure failed, or the verdict was unparseable (a judge schema
 * failure, not a quality signal). All three are best-effort — mirroring the
 * per-unit web-research fallback — so a semester run never dies on the
 * reviewer. Returns corrective feedback to feed the deck's bounded retry loop
 * ONLY for a parseable `adequate: false` verdict with concrete findings.
 */
async function reviewOutlineDeck(
  deck: { title?: string; objectives?: string[]; lessons?: Array<{ title?: string }> },
  outlines: SceneOutline[],
  deckIndex: number,
  run: MultiUnitOutlineRun,
  enqueue: (event: Record<string, unknown>) => void,
): Promise<string | null> {
  const reviewPrompt = buildPrompt(PROMPT_IDS.UNIT_REVIEW, {
    unitSummary: buildUnitReviewSummary(
      {
        title: deck.title ?? `Deck ${deckIndex + 1}`,
        objectives: deck.objectives ?? [],
        lessons: (deck.lessons ?? []).map((lesson, index) => ({
          title: lesson.title ?? `Lesson ${index + 1}`,
          objectives: [],
          durationMinutes: 0,
          sceneTarget: 0,
          outlines: [],
        })),
      },
      outlines,
    ),
  });
  if (!reviewPrompt) {
    log.warn(`Review prompt template not found for deck ${deckIndex + 1}; accepting the deck`);
    return null;
  }

  try {
    const judgeCallModel = run.reviewCallModel ?? run.callModel;
    const text = await judgeCallModel({ system: reviewPrompt.system, user: reviewPrompt.user });
    const parsed = parseJsonResponse<UnitReviewVerdict>(text);
    const { verdict, errors } = validateUnitReviewVerdict(parsed);
    enqueue({
      type: 'unitReview',
      index: deckIndex,
      unit: deck.title ?? `Deck ${deckIndex + 1}`,
      adequate: verdict?.adequate ?? false,
      findings: verdict ? verdict.findings : errors,
    });
    if (verdict?.adequate) {
      return null;
    }
    // An unparseable verdict (null) is a judge SCHEMA failure — the model did
    // not return the required {adequate, findings} shape — not a quality
    // signal. Accept the deck rather than feeding a spurious corrective loop
    // that, after MAX_BLUEPRINT_ATTEMPTS, would kill the whole run. Only a
    // parseable `adequate: false` verdict with concrete findings drives a retry.
    if (!verdict) {
      log.warn(
        `Review judge returned an unparseable verdict for deck ${deckIndex + 1}; accepting the deck (best-effort gate): ${errors.join('; ') || 'unknown schema error'}`,
      );
      return null;
    }
    return summarizeUnitReviewFindings({ adequate: false, findings: verdict.findings });
  } catch (error) {
    if (run.signal?.aborted) throw error;
    log.warn(
      `Review judge failed for deck ${deckIndex + 1}; accepting the deck (best-effort gate):`,
      error,
    );
    return null;
  }
}

async function generateMultiUnitOutlines(run: MultiUnitOutlineRun): Promise<MultiUnitOutlineResult> {
  const { controller, encoder, signal, courseContract } = run;
  const reviewMode = resolveOutlineReviewMode();
  const enqueue = (event: Record<string, unknown>) => {
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch {
      // Client disconnected mid-generation: swallow the write. The in-flight
      // unit still completes (its LLM call is not tied to req.signal), and the
      // loop stops at the next abort check instead of dying mid-enqueue.
    }
  };
  const checkAborted = () => {
    if (signal?.aborted) throw new Error('Client disconnected');
  };

  // ---- Phase A: syllabus (unit/lesson structure only) ----
  // Resuming a partial run reuses the client-checkpointed syllabus and skips
  // this call entirely.
  let syllabus: ParsedOutlineResponse | null = run.resumeSyllabus ?? null;

  if (!syllabus) {
    const syllabusPrompt = buildPrompt(PROMPT_IDS.COURSE_SYLLABUS, {
      ...run.baseVariables,
      courseContract: renderSyllabusContract(courseContract),
    });
    if (!syllabusPrompt) throw new Error('Syllabus prompt template not found');

    let syllabusFeedback: string | undefined;
    for (let attempt = 1; attempt <= MAX_BLUEPRINT_ATTEMPTS; attempt++) {
      checkAborted();
      const userPrompt = syllabusFeedback
        ? `${syllabusPrompt.user}\n\n## Correction Required\n\n${syllabusFeedback}`
        : syllabusPrompt.user;
      try {
        const text = await run.callModel({ system: syllabusPrompt.system, user: userPrompt });
        const parsed = parseJsonResponse<ParsedOutlineResponse>(text);
        if (!parsed || !Array.isArray(parsed.units)) {
          syllabusFeedback = 'Return the syllabus JSON object with a "units" array as specified.';
          continue;
        }
        const errors = validateSyllabusStructure(parsed, courseContract);
        if (errors.length === 0) {
          // Normalize: the flat lessons list drives lesson titles during
          // assembly; the syllabus shape nests them under units.
          syllabus = {
            ...parsed,
            lessons: parsed.lessons ?? parsed.units.flatMap((unit) => unit.lessons ?? []),
          };
          break;
        }
        syllabusFeedback = `Your previous response did NOT meet the syllabus contract:\n${errors.map((e) => `- ${e}`).join('\n')}\nFix the structure and return the corrected JSON.`;
      } catch (error) {
        if (signal?.aborted) throw error;
        log.warn(`Syllabus attempt ${attempt} failed:`, error);
        if (attempt >= MAX_BLUEPRINT_ATTEMPTS) throw error;
      }
    }
    if (!syllabus) {
      throw new Error(`Syllabus did not meet the contract after ${MAX_BLUEPRINT_ATTEMPTS} attempts`);
    }
  }
  checkAborted();
  enqueue({
    type: 'syllabus',
    units: syllabus.units,
    lessons: syllabus.lessons,
    languageDirective: syllabus.languageDirective,
    courseTitle: syllabus.courseTitle,
    audience: syllabus.audience,
    objectives: syllabus.objectives,
  });

  // ---- Phase B: one outline call per LESSON, in parallel ----
  // Lessons are the atomic unit of work: each call produces a small, focused
  // deck (a handful of scenes) for ONE lesson, so the model writes concrete
  // scenes and the judge reviews fairly. Scenes stream to the client as soon
  // as each lesson (and every lower-numbered lesson) completes, instead of
  // waiting for whole 50-scene units. Sibling lessons are named in every
  // call's context so parallel generation stays non-redundant and on-sequence.

  // Global lesson numbering drives everything; units chunk the flat list.
  const lessonTargets = courseContract.lessonSceneTargets;
  const lessonStartOffsets: number[] = [];
  {
    let offset = 0;
    for (const target of lessonTargets) {
      lessonStartOffsets.push(offset);
      offset += target;
    }
  }
  // unit -> first global lesson index and lesson count (for release/checkpoint).
  const unitStartLesson: number[] = [];
  const unitLessonTotal: number[] = [];
  {
    let offset = 0;
    for (const count of courseContract.unitLessonCounts) {
      unitStartLesson.push(offset);
      unitLessonTotal.push(count);
      offset += count;
    }
  }
  const unitIndexOfLesson = (lessonIndex: number): number => {
    for (let u = 0; u < unitStartLesson.length; u++) {
      if (lessonIndex < unitStartLesson[u] + unitLessonTotal[u]) return u;
    }
    return Math.max(0, unitStartLesson.length - 1);
  };

  const resumeFrom = run.resumeFromUnitIndex ?? 0;
  const resumeLessonIndex = unitStartLesson[resumeFrom] ?? 0;
  const allOutlines: SceneOutline[] = [];
  const usedOutlineIds = new Set<string>();

  // Re-dedupe ids globally and emit a scene to the client with its global index.
  const emitOutline = (outline: SceneOutline) => {
    const unique = ensureUniqueOutlineId(outline, usedOutlineIds);
    allOutlines.push(unique);
    enqueue({ type: 'outline', data: unique, index: allOutlines.length - 1 });
  };

  // Replay the checkpointed outlines from the prior partial run first, so the
  // client's collected set rebuilds the complete ordered deck.
  for (const outline of run.resumeOutlines ?? []) {
    emitOutline(outline);
  }

  // Best-effort per-unit web research, memoized so a unit's lessons share one
  // search instead of each issuing their own.
  const researchByUnit = new Map<number, Promise<{ context: string; chunks: PdfChunk[] }>>();
  const getUnitResearch = (unitIndex: number) => {
    const existing = researchByUnit.get(unitIndex);
    if (existing) return existing;
    const wsConfig = run.webSearchConfig;
    const promise = (async (): Promise<{ context: string; chunks: PdfChunk[] }> => {
      if (!wsConfig?.providerId) {
        return { context: run.researchContext || 'None', chunks: [] };
      }
      const unit = (syllabus!.units ?? [])[unitIndex];
      const query =
        (`${unit?.title ?? ''} ${(unit?.objectives ?? []).join(' ')}`.trim() ||
          `Unit ${unitIndex + 1}`) as string;
      try {
        const result = await searchWeb({
          providerId: wsConfig.providerId as WebSearchProviderId,
          query,
          apiKey: wsConfig.apiKey,
          baseUrl: wsConfig.baseUrl,
          maxResults: 6,
          baiduSubSources: wsConfig.baiduSubSources,
        });
        const chunks = webSourcesToChunks(result);
        const context = [
          run.researchContext || '',
          formatWebSourceLegend(result),
          '',
          'Search results:',
          formatSearchResultsAsContext(result),
        ]
          .filter(Boolean)
          .join('\n');
        return { context, chunks };
      } catch (error) {
        log.warn(
          `Per-unit web research failed for unit ${unitIndex + 1}; falling back to global context:`,
          error,
        );
        return { context: run.researchContext || 'None', chunks: [] };
      }
    })();
    researchByUnit.set(unitIndex, promise);
    return promise;
  };

  // Build per-unit lesson chains (skipping units already checkpointed). Units
  // generate their lessons SEQUENTIALLY so each lesson sees the unit's prior
  // scenes ("covered so far") for continuity; units themselves run in parallel.
  const syllabusUnits = syllabus!.units ?? [];
  const syllabusLessons = syllabus!.lessons ?? [];
  const pendingUnits: Array<{ unitIndex: number; lessons: PendingLesson[] }> = [];
  for (let unitIndex = resumeFrom; unitIndex < courseContract.unitCount; unitIndex++) {
    const lessons: PendingLesson[] = [];
    const first = unitStartLesson[unitIndex];
    for (let li = 0; li < unitLessonTotal[unitIndex]; li++) {
      const lessonIndex = first + li;
      const unit = syllabusUnits[unitIndex] ?? {};
      const lesson =
        unit.lessons?.[li] ??
        syllabusLessons[lessonIndex] ?? {
          title: `Lesson ${lessonIndex + 1}`,
          objectives: [],
        };
      lessons.push({ lessonIndex, unitIndex, lessonIndexInUnit: li, unit, lesson });
    }
    pendingUnits.push({ unitIndex, lessons });
  }

  const completedLessons = new Map<
    number,
    { outlines: SceneOutline[]; events: Array<Record<string, unknown>> }
  >();
  const unitReleasedScenes = new Map<number, number>();
  let nextLessonRelease = resumeLessonIndex;

  const releaseReadyLessons = () => {
    while (completedLessons.has(nextLessonRelease)) {
      const result = completedLessons.get(nextLessonRelease)!;
      const unitIndex = unitIndexOfLesson(nextLessonRelease);
      for (const event of result.events) enqueue(event);
      for (const outline of result.outlines) {
        emitOutline(outline);
      }
      unitReleasedScenes.set(
        unitIndex,
        (unitReleasedScenes.get(unitIndex) ?? 0) + result.outlines.length,
      );
      // Checkpoint signal: the client persists this unit's outlines as complete
      // (emitted once the unit's last lesson releases).
      if (nextLessonRelease === unitStartLesson[unitIndex] + unitLessonTotal[unitIndex] - 1) {
        enqueue({
          type: 'unitDone',
          index: unitIndex,
          count: unitReleasedScenes.get(unitIndex) ?? result.outlines.length,
        });
      }
      nextLessonRelease++;
    }
  };

  // Generate ONE lesson's outline deck, handed its unit's "covered so far"
  // summary so scenes stay continuous and non-redundant within the unit.
  const generateLessonOutline = async (
    entry: PendingLesson,
    coveredSoFar: string[],
  ): Promise<{ outlines: SceneOutline[]; events: Array<Record<string, unknown>> }> => {
    const { lessonIndex, unitIndex, lessonIndexInUnit, unit, lesson } = entry;
    checkAborted();
    const target = lessonTargets[lessonIndex];
    const globalStart = lessonStartOffsets[lessonIndex];
    const { context: unitResearchContext, chunks: unitChunks } = await getUnitResearch(
      unitIndex,
    );

    const siblingLessons = (unit.lessons ?? []).map((l, i) => {
      const marker = i === lessonIndexInUnit ? '  <-- THIS LESSON (generate only this one)' : '';
      return `  ${i + 1}. ${l.title ?? `Lesson ${i + 1}`}${marker}`;
    });
    const lessonContext = [
      `## Syllabus Context (Unit ${unitIndex + 1} of ${courseContract.unitCount}, Lesson ${lessonIndexInUnit + 1} of ${unitLessonTotal[unitIndex]})`,
      '',
      `Unit title: ${unit.title ?? ''}`,
      `Unit objectives: ${(unit.objectives ?? []).join('; ')}`,
      `Lesson title: ${lesson.title ?? ''}`,
      `Lesson objectives: ${(lesson.objectives ?? []).join('; ')}`,
      '',
      'Lessons in this unit (you generate ONLY this lesson; the siblings cover the others):',
      ...siblingLessons,
      ...(coveredSoFar.length > 0
        ? ['', 'Covered so far in this unit (build on this; do NOT repeat it):', ...coveredSoFar]
        : []),
      '',
      `Generate EXACTLY ${target} scenes for this lesson. Global outline numbering continues from #${globalStart + 1}.`,
    ].join('\n');

    const lessonPrompts = buildPrompt(run.promptId as Parameters<typeof buildPrompt>[0], {
      ...run.baseVariables,
      requirement: `${run.requirement}\n\n${lessonContext}`,
      researchContext: unitResearchContext,
      courseContract: renderLessonScopedContract(courseContract, lessonIndex, run.courseType),
    });
    if (!lessonPrompts) throw new Error('Lesson outline prompt template not found');

    const events: Array<Record<string, unknown>> = [
      {
        type: 'lesson',
        index: lessonIndex,
        unitIndex,
        title: lesson.title ?? `Lesson ${lessonIndex + 1}`,
        total: courseContract.lessonCount,
      },
    ];
    const localEnqueue = (event: Record<string, unknown>) => {
      events.push(event);
    };
    const localUsedIds = new Set<string>();

    let lessonOutlines: SceneOutline[] | null = null;
    let lessonFeedback: string | undefined;
    for (let attempt = 1; attempt <= MAX_BLUEPRINT_ATTEMPTS; attempt++) {
      checkAborted();
      const userPrompt = lessonFeedback
        ? `${lessonPrompts.user}\n\n## Correction Required\n\n${lessonFeedback}`
        : lessonPrompts.user;
      try {
        const text = await run.callModel({ system: lessonPrompts.system, user: userPrompt });
        const parsed = parseJsonResponse<ParsedOutlineResponse | SceneOutline[]>(text);
        const rawOutlines = Array.isArray(parsed) ? parsed : parsed?.outlines;
        if (!Array.isArray(rawOutlines) || rawOutlines.length === 0) {
          lessonFeedback = 'Return the wrapper JSON object with the "outlines" array as specified.';
          continue;
        }

        // Global ids + global orders (offsets are precomputed so lessons can
        // number their outlines deterministically).
        const enriched = rawOutlines.map((outline, index) =>
          sanitizeNonTaskEngineOutline({
            ...outline,
            id: outline.id || nanoid(),
            order: globalStart + index + 1,
          }),
        );
        const uniquified = enriched.map((outline) =>
          ensureUniqueOutlineId(outline, localUsedIds),
        );

        // Structural check for THIS lesson: scene shape + exact count.
        // A ±1 miss is tolerated only on the final attempt.
        const shapeErrors = uniquified.flatMap(validateOutlineShape);
        const countMatches =
          uniquified.length === target ||
          (attempt === MAX_BLUEPRINT_ATTEMPTS && Math.abs(uniquified.length - target) <= 1);
        if (shapeErrors.length === 0 && countMatches) {
          // Phase 2 §15.5: per-lesson review gate. The judge reviews the
          // lesson's small deck against ITS objectives — a rejection
          // regenerates just this lesson (cheap), never the whole unit.
          // `off` skips the judge entirely (models that can't self-grade).
          const reviewFeedback =
            reviewMode === 'off'
              ? null
              : await reviewOutlineDeck(
                  {
                    title: lesson.title ?? `Lesson ${lessonIndex + 1}`,
                    objectives: lesson.objectives ?? [],
                    lessons: [],
                  },
                  uniquified,
                  lessonIndex,
                  run,
                  localEnqueue,
                );
          if (reviewFeedback === null) {
            lessonOutlines = uniquified;
            break;
          }
          lessonFeedback = reviewFeedback;
          if (attempt >= MAX_BLUEPRINT_ATTEMPTS) {
            if (reviewMode === 'strict') {
              // The gate exhausted its budget — never accept a lesson the
              // reviewer rejected.
              throw new Error(
                `Lesson ${lessonIndex + 1} (unit ${unitIndex + 1}) did not pass the review gate after ${MAX_BLUEPRINT_ATTEMPTS} attempts`,
              );
            }
            // Tolerant: the lesson met the shape/count contract, so a lone
            // over-strict judge must not sink the whole course. Keep the
            // lesson and surface the deferred findings.
            log.warn(
              `Lesson ${lessonIndex + 1} (unit ${unitIndex + 1}) accepted after ${MAX_BLUEPRINT_ATTEMPTS} review attempts with findings: ${reviewFeedback.replace(/\s+/g, ' ').slice(0, 240)}`,
            );
            const lastEvent = events[events.length - 1];
            if (lastEvent && lastEvent.type === 'unitReview') {
              lastEvent.acceptedAfterBudget = true;
            }
            lessonOutlines = uniquified;
            break;
          }
          continue;
        }
        const problems = [...shapeErrors];
        if (!countMatches) {
          problems.push(
            `This lesson must contain EXACTLY ${target} scenes; you produced ${uniquified.length}.`,
          );
        }
        lessonFeedback = problems.join('\n');
      } catch (error) {
        if (signal?.aborted) throw error;
        log.warn(`Lesson ${lessonIndex + 1} outline attempt ${attempt} failed:`, error);
        if (attempt >= MAX_BLUEPRINT_ATTEMPTS) throw error;
      }
    }
    if (!lessonOutlines) {
      throw new Error(
        `Lesson ${lessonIndex + 1} outlines did not meet the contract after ${MAX_BLUEPRINT_ATTEMPTS} attempts`,
      );
    }

    // Attach per-scene retrieval context from the unit's web research —
    // same machinery as the PDF path (Pillar 3b), citation markers "[source N]".
    const groundedOutlines = lessonOutlines.map((outline) => {
      if (outline.retrievalContext || unitChunks.length === 0) return outline;
      const query = `${outline.title}\n${outline.description}\n${(outline.keyPoints ?? []).join('\n')}`;
      const retrieved = retrieveChunks(query, unitChunks);
      if (retrieved.length === 0) return outline;
      return { ...outline, retrievalContext: formatRetrievalContext(retrieved) };
    });

    return { outlines: groundedOutlines, events };
  };

  // Run units in parallel (bounded concurrency); within a unit, lessons run
  // sequentially and each is handed the unit's accumulating coverage summary.
  // Scenes still stream to the client as soon as the contiguous prefix of
  // lessons completes (releaseReadyLessons).
  const unitPromises = lazyBoundedMap(
    pendingUnits,
    LLM_CALL_CONCURRENCY,
    async ({ lessons }) => {
      const coveredSoFar: string[] = [];
      for (const entry of lessons) {
        checkAborted();
        const result = await generateLessonOutline(entry, coveredSoFar);
        completedLessons.set(entry.lessonIndex, result);
        releaseReadyLessons();
        coveredSoFar.push(
          `- ${entry.lesson.title ?? `Lesson ${entry.lessonIndex + 1}`}: ${result.outlines
            .map((outline) => outline.title)
            .filter(Boolean)
            .slice(0, 5)
            .join('; ')}`,
        );
      }
    },
  ).map((promise) =>
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    ),
  );

  for (const promise of unitPromises) {
    const settled = await promise;
    if (!settled.ok) throw settled.error;
  }

  // ---- Phase C: assemble + full contract validation ----
  const blueprint = buildCourseBlueprint(
    {
      languageDirective: syllabus.languageDirective,
      courseTitle: syllabus.courseTitle,
      outlines: allOutlines,
      audience: syllabus.audience,
      objectives: syllabus.objectives,
      lessons: syllabus.lessons,
      units: syllabus.units,
    },
    run.requirement,
    courseContract,
    run.courseType,
    syllabus.courseTitle ?? run.requirement.slice(0, 30),
  );
  const fullReport = validateBlueprint(blueprint, { tolerance: true });
  if (!fullReport.valid) {
    throw new Error(
      `Assembled deck did not meet the course contract: ${fullReport.errors.slice(0, 5).join('; ')}`,
    );
  }

  return {
    blueprint,
    outlines: blueprint.lessons.flatMap((lesson) => lesson.outlines),
    languageDirective: syllabus.languageDirective ?? null,
    courseTitle: syllabus.courseTitle ?? null,
  };
}

export async function POST(req: NextRequest) {
  let requirementSnippet: string | undefined;
  let resolvedModelString: string | undefined;
  try {
    const body = await req.json();

    // Get API configuration from request headers/body
    const {
      model: languageModel,
      modelInfo,
      modelString,
      thinkingConfig,
    } = await resolveModelFromRequest(req, body, 'scene-outlines-stream');
    resolvedModelString = modelString;

    if (!body.requirements) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Requirements are required');
    }

    const { requirements, pdfText, pdfImages, imageMapping, researchContext, agents, durationMinutes, sizePreset, webSearchConfig, pdfHandle, pdfDigest, resumeSyllabus, resumeOutlines, resumeFromUnitIndex } = body as {
      requirements: UserRequirements;
      pdfText?: string;
      pdfImages?: PdfImage[];
      imageMapping?: ImageMapping;
      researchContext?: string;
      agents?: AgentInfo[];
      durationMinutes?: number;
      sizePreset?: unknown;
      pdfHandle?: string;
      pdfDigest?: DocumentDigest;
      webSearchConfig?: {
        providerId?: string;
        apiKey?: string;
        baseUrl?: string;
        baiduSubSources?: BaiduSubSources;
      };
      resumeSyllabus?: ParsedOutlineResponse;
      resumeOutlines?: SceneOutline[];
      resumeFromUnitIndex?: number;
    };
    requirementSnippet = requirements?.requirement?.substring(0, 60);

    // ── Full-document coverage (Phase 2 §16) ──
    // With a handle, the outline prompt gets the coverage DIGEST (the whole
    // document as an enumerative map) and per-scene retrieval runs over the
    // FULL text loaded from the index store — no truncation anywhere.
    const storedIndex = pdfHandle ? await loadDocumentIndex(pdfHandle) : null;
    const indexChunks = storedIndex?.chunks ?? [];
    const digestRender = pdfDigest
      ? renderDocumentDigest(pdfDigest, { maxChars: DIGEST_TARGET_CHARS })
      : storedIndex && storedIndex.digest.sections.length > 0
        ? renderDocumentDigest(storedIndex.digest, { maxChars: DIGEST_TARGET_CHARS })
        : null;
    const digestText = digestRender?.text ?? '';
    const trimmedDigestTopics = digestRender?.trimmedTopics ?? 0;
    if (trimmedDigestTopics > 0) {
      // §16: a digest that exceeds the outline-prompt budget has topics pruned
      // from its largest cards. Report it — never drop the signal silently.
      log.warn(
        `Coverage digest exceeded the ${DIGEST_TARGET_CHARS}-char budget; ${trimmedDigestTopics} topic(s) trimmed from the largest cards`,
      );
    }
    const rawTierText =
      storedIndex && storedIndex.digest.sections.length === 0 ? storedIndex.text : '';
    const effectivePdfContent = digestText
      ? digestText
      : rawTierText
        ? rawTierText
        : pdfText
          ? pdfText.substring(0, MAX_PDF_CONTENT_CHARS)
          : 'None';

    // Build user profile string for language inference context
    const userProfileText =
      requirements.userNickname || requirements.userBio
        ? `## Student Profile\n\nStudent: ${requirements.userNickname || 'Unknown'}${requirements.userBio ? ` ΓÇö ${requirements.userBio}` : ''}\n\nConsider this student's background when designing the course. Adapt difficulty, examples, and teaching approach accordingly.\n\n---`
        : '';

    // Detect vision capability
    const hasVision = !!modelInfo?.capabilities?.vision;

    // Build prompt (same logic as generateSceneOutlinesFromRequirements)
    let availableImagesText = 'No images available';
    let visionImages: Array<{ id: string; src: string }> | undefined;

    if (pdfImages && pdfImages.length > 0) {
      if (hasVision && imageMapping) {
        // Vision mode: split into vision images (first N) and text-only (rest)
        const sortedImages = sortDocumentImagesForVision(pdfImages);
        const allWithSrc = sortedImages.filter((img) => imageMapping[img.id]);
        const visionSlice = allWithSrc.slice(0, MAX_VISION_IMAGES);
        const textOnlySlice = allWithSrc.slice(MAX_VISION_IMAGES);
        const noSrcImages = sortedImages.filter((img) => !imageMapping[img.id]);

        const visionDescriptions = visionSlice.map((img) => formatImagePlaceholder(img));
        const textDescriptions = [...textOnlySlice, ...noSrcImages].map((img) =>
          formatImageDescription(img),
        );
        availableImagesText = [...visionDescriptions, ...textDescriptions].join('\n');

        visionImages = visionSlice.map((img) => ({
          id: img.id,
          src: imageMapping[img.id],
          width: img.width,
          height: img.height,
        }));
      } else {
        // Text-only mode: full descriptions
        availableImagesText = pdfImages.map((img) => formatImageDescription(img)).join('\n');
      }
    }

    // Build media snippet conditions based on enabled flags.
    const imageGenerationEnabled = req.headers.get('x-image-generation-enabled') === 'true';
    const videoGenerationEnabled = req.headers.get('x-video-generation-enabled') === 'true';
    const mediaGenerationEnabled = imageGenerationEnabled || videoGenerationEnabled;
    const hasSourceImages = (pdfImages?.length ?? 0) > 0;

    // Build teacher context from agents (if available)
    const teacherContext = formatTeacherPersonaForPrompt(agents);

    // Check if Interactive Mode or server-enabled Task Engine mode is enabled.
    const interactiveMode = requirements.interactiveMode ?? false;
    const taskEngineMode = resolveVocationalActive(requirements);
    const promptId = taskEngineMode
      ? PROMPT_IDS.TASK_ENGINE_OUTLINES
      : interactiveMode
        ? PROMPT_IDS.INTERACTIVE_OUTLINES
        : PROMPT_IDS.REQUIREMENTS_TO_OUTLINES;

    // The course contract governs the default and interactive paths. The
    // task-engine path has its own normalization and keeps legacy counts.
    const contractMode = !taskEngineMode;
    const courseType = inferCourseType(requirements.requirement);
    const requestDuration = contractMode
      ? resolveRequestDuration(sizePreset, durationMinutes, requirements.requirement)
      : { minutes: undefined, source: 'preset' as const };
    const courseContract = contractMode
      ? deriveContractForRequest(sizePreset, courseType, requestDuration.minutes)
      : null;
    const resolvedDuration = courseContract?.durationMinutes ?? clampDurationMinutes(
      durationMinutes ?? parseDurationFromText(requirements.requirement) ?? DEFAULT_DURATION_MINUTES,
    );
    const courseContractText = courseContract
      ? renderCourseContract(courseContract, courseType)
      : '';

    const baseVariables = {
      requirement: requirements.requirement,
      pdfContent: effectivePdfContent,
      availableImages: availableImagesText,
      researchContext: researchContext || 'None',
      hasSourceImages,
      imageEnabled: imageGenerationEnabled,
      videoEnabled: videoGenerationEnabled,
      mediaEnabled: mediaGenerationEnabled,
      teacherContext,
      userProfile: userProfileText,
      courseContract: courseContractText,
      resolvedDurationMinutes: courseContract?.durationMinutes ?? resolvedDuration,
    };

    const prompts = buildPrompt(promptId, baseVariables);
    const multiUnit = contractMode && courseContract !== null && courseContract.unitCount > 1;

    if (!prompts) {
      return apiError('INTERNAL_ERROR', 500, 'Prompt template not found');
    }

    log.info(
      `Generating outlines: "${requirements.requirement.substring(0, 50)}" [model=${modelString}]`,
    );
    log.info(
      `Outline contract [preset=${courseContract?.sizePreset ?? 'none'}, duration=${courseContract?.durationMinutes ?? resolvedDuration}min (${requestDuration.source}), lessons=${courseContract?.lessonCount ?? 'n/a'}, units=${courseContract?.unitCount ?? 'n/a'}, scenes=${courseContract?.totalSceneTarget ?? 'n/a'}, multiUnit=${multiUnit}, digestSections=${storedIndex?.digest.sections.length ?? 0}]`,
    );

    // Create SSE stream with heartbeat to prevent connection timeout
    const encoder = new TextEncoder();
    const HEARTBEAT_INTERVAL_MS = 15_000;
    const stream = new ReadableStream({
      async start(controller) {
        // Heartbeat: periodically send SSE comments to keep the connection alive.
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        const startHeartbeat = () => {
          stopHeartbeat();
          heartbeatTimer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`:heartbeat\n\n`));
            } catch {
              stopHeartbeat();
            }
          }, HEARTBEAT_INTERVAL_MS);
        };
        const stopHeartbeat = () => {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
        };

        const MAX_STREAM_RETRIES = 2;
        // Hard ceiling on the accumulated stream buffer. Legitimate outline
        // JSON is small (tens of KB); anything past this is a runaway/degenerate
        // generation and must not be allowed to grow the heap unbounded.
        const MAX_OUTLINE_STREAM_BYTES = 512 * 1024;

        try {
          startHeartbeat();

          let parsedOutlines: SceneOutline[] = [];
          let languageDirective: string | null = null;
          let courseTitle: string | null = null;
          let lastError: string | undefined;
          let correctiveFeedback: string | undefined;
          let finalBlueprint: CourseBlueprint | null = null;
          let contractFailed = false;

          if (multiUnit && courseContract) {
            // Multi-unit path (Phase 2 §15.8): syllabus call + per-unit
            // outline calls, each bounded. No per-unit 'retry' events are
            // emitted — the client keeps already-collected unit outlines.
            try {
              const callModel = async ({ system, user }: { system: string; user: string }) => {
                const result = await callLLM(
                  {
                    model: languageModel,
                    system,
                    prompt: user,
                    maxOutputTokens: modelInfo?.outputWindow,
                  },
                  'scene-outlines-stream-multi-unit',
                  undefined,
                  thinkingConfig,
                );
                return result.text;
              };
              // Configurable judge model: when OPENMAIC_OUTLINE_REVIEW_MODEL is
              // set, the review gate judges with a different model than the
              // generator (the generator grading its own output is a systematic
              // blind spot). Unset → the gate uses the generator's model.
              let reviewCallModel:
                | ((params: { system: string; user: string }) => Promise<string>)
                | undefined;
              const reviewModelString = process.env.OPENMAIC_OUTLINE_REVIEW_MODEL;
              if (reviewModelString) {
                // Fail the run rather than degrade silently: an unresolvable
                // judge must not quietly turn every deck review into a
                // warn-and-accept no-op.
                const judge = await resolveModel({ modelString: reviewModelString }).catch(
                  (error: unknown) => {
                    throw new Error(
                      `OPENMAIC_OUTLINE_REVIEW_MODEL="${reviewModelString}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
                    );
                  },
                );
                if (!judge?.model) {
                  throw new Error(
                    `OPENMAIC_OUTLINE_REVIEW_MODEL="${reviewModelString}" resolved to no model`,
                  );
                }
                reviewCallModel = async ({ system, user }) => {
                  const result = await callLLM(
                    {
                      model: judge.model,
                      system,
                      prompt: user,
                      maxOutputTokens: judge.modelInfo?.outputWindow,
                    },
                    'scene-outlines-stream-review',
                    undefined,
                    judge.thinkingConfig,
                  );
                  return result.text;
                };
              }
              const multiResult = await generateMultiUnitOutlines({
                requirement: requirements.requirement,
                promptId,
                baseVariables,
                researchContext: researchContext || '',
                webSearchConfig,
                courseContract,
                courseType,
                callModel,
                reviewCallModel,
                signal: req.signal,
                controller,
                encoder,
                resumeSyllabus,
                resumeOutlines,
                resumeFromUnitIndex:
                  typeof resumeFromUnitIndex === 'number' ? resumeFromUnitIndex : undefined,
              });
              finalBlueprint = multiResult.blueprint;
              parsedOutlines = multiResult.outlines;
              languageDirective = multiResult.languageDirective;
              courseTitle = multiResult.courseTitle;
            } catch (error) {
              // Client disconnected: stop immediately.
              if (req.signal?.aborted) {
                stopHeartbeat();
                return;
              }
              lastError = error instanceof Error ? error.message : String(error);
              contractFailed = true;
              log.error(`Multi-unit outline generation failed:`, error);
            }
          } else {
          // Single-unit (streaming) path. Unlike the multi-unit path above, this
          // STREAMS text to the client, so there is no server-side result to
          // persist — aborting the upstream request the moment the client goes
          // away (rather than completing it) is the correct behaviour here, not
          // an inconsistency: buffering for a dead connection is pure waste.
          for (let attempt = 1; attempt <= MAX_STREAM_RETRIES + 1; attempt++) {
            try {
              let fullText = '';
              let scanFrom = 0;
              parsedOutlines = [];
              languageDirective = null;
              courseTitle = null;
              contractFailed = false;
              const usedOutlineIds = new Set<string>();

              // Rebuild per attempt: corrective feedback is appended to the
              // user prompt when the previous attempt missed the contract.
              const userPrompt = correctiveFeedback
                ? `${prompts.user}\n\n## Correction Required\n\n${correctiveFeedback}`
                : prompts.user;
              const streamParams = visionImages?.length
                ? {
                    model: languageModel,
                    system: prompts.system,
                    messages: [
                      {
                        role: 'user' as const,
                        content: buildVisionUserContent(userPrompt, visionImages),
                      },
                    ],
                    maxOutputTokens: modelInfo?.outputWindow,
                    // Tear down the upstream LLM request when the client disconnects,
                    // instead of letting it run to completion for a dead connection.
                    abortSignal: req.signal,
                  }
                : {
                    model: languageModel,
                    system: prompts.system,
                    prompt: userPrompt,
                    maxOutputTokens: modelInfo?.outputWindow,
                    abortSignal: req.signal,
                  };

              const textStream = streamLLM(
                streamParams,
                'scene-outlines-stream',
                thinkingConfig,
              ).textStream;

              for await (const chunk of textStream) {
                // Stop doing work the moment the client goes away ΓÇö otherwise
                // generation keeps running and buffering for a dead connection.
                if (req.signal?.aborted) {
                  stopHeartbeat();
                  return;
                }

                fullText += chunk;

                if (fullText.length > MAX_OUTLINE_STREAM_BYTES) {
                  log.warn(
                    `Outline stream exceeded ${MAX_OUTLINE_STREAM_BYTES} bytes (len=${fullText.length}); stopping read and finalizing with ${parsedOutlines.length} outline(s)`,
                  );
                  break;
                }

                // Try to extract language directive early
                if (!languageDirective) {
                  languageDirective = extractLanguageDirective(fullText);
                  if (languageDirective) {
                    const ldEvent = JSON.stringify({
                      type: 'languageDirective',
                      data: languageDirective,
                    });
                    controller.enqueue(encoder.encode(`data: ${ldEvent}\n\n`));
                  }
                }

                // Try to extract course title early (same pattern as languageDirective)
                if (!courseTitle) {
                  courseTitle = extractCourseTitle(fullText);
                  if (courseTitle) {
                    const ctEvent = JSON.stringify({
                      type: 'courseTitle',
                      data: courseTitle,
                    });
                    controller.enqueue(encoder.encode(`data: ${ctEvent}\n\n`));
                  }
                }

                // Try to extract new outlines from the accumulated text,
                // resuming the scan from where the previous chunk left off.
                const { outlines: newOutlines, scanFrom: nextScanFrom } = extractNewOutlines(
                  fullText,
                  scanFrom,
                );
                scanFrom = nextScanFrom;
                for (const outline of newOutlines) {
                  // Ensure ID and order
                  const enrichedBase = {
                    ...outline,
                    order: parsedOutlines.length + 1,
                  };
                  const normalized = taskEngineMode
                    ? normalizeTaskEngineOutline(enrichedBase, requirements.requirement)
                    : sanitizeNonTaskEngineOutline(enrichedBase);
                  const enriched = ensureUniqueOutlineId(normalized, usedOutlineIds);
                  parsedOutlines.push(enriched);

                  const event = JSON.stringify({
                    type: 'outline',
                    data: enriched,
                    index: parsedOutlines.length - 1,
                  });
                  controller.enqueue(encoder.encode(`data: ${event}\n\n`));
                }
              }

              // Validate: got outlines?
              if (parsedOutlines.length > 0) {
                if (!courseTitle) {
                  // The head-bound streaming scan can miss a title the model
                  // placed after the outlines array or past the 8KB head window;
                  // recover it from the now-complete response before finalizing.
                  courseTitle = extractCourseTitleFromComplete(fullText);
                }

                // Contract mode: assemble the blueprint and hold it to the
                // contract. A thin deck re-streams with corrective feedback
                // (bounded); on final exhaustion the run fails with the report.
                if (contractMode && courseContract) {
                  const meta = extractWrapperMeta(fullText);
                  // Replace sequential gen_img_N/gen_vid_N with globally unique IDs
                  const uniquifiedOutlines = uniquifyMediaElementIds(parsedOutlines);
                  const blueprint = buildCourseBlueprint(
                    {
                      languageDirective: languageDirective || undefined,
                      courseTitle: courseTitle || undefined,
                      outlines: uniquifiedOutlines,
                      audience: meta?.audience,
                      objectives: meta?.objectives,
                      lessons: meta?.lessons,
                      units: meta?.units,
                    },
                    requirements.requirement,
                    courseContract,
                    courseType,
                    courseTitle ?? requirements.requirement.slice(0, 30),
                  );
                  const report = validateBlueprint(blueprint, {
                    tolerance: attempt === MAX_BLUEPRINT_ATTEMPTS,
                  });
                  if (report.valid) {
                    finalBlueprint = blueprint;
                    break;
                  }
                  correctiveFeedback = summarizeBlueprintValidation(report);
                  lastError = correctiveFeedback;
                  contractFailed = true;
                  log.warn(
                    `Blueprint contract not met (attempt ${attempt}/${MAX_BLUEPRINT_ATTEMPTS}): ${report.errors.length} error(s), ${report.warnings.length} warning(s)`,
                  );
                  if (attempt < MAX_BLUEPRINT_ATTEMPTS) {
                    const retryEvent = JSON.stringify({
                      type: 'retry',
                      attempt,
                      maxAttempts: MAX_BLUEPRINT_ATTEMPTS,
                      reason: 'courseContract',
                    });
                    controller.enqueue(encoder.encode(`data: ${retryEvent}\n\n`));
                    continue;
                  }
                  // Exhausted: fall through to the error path (never accept
                  // a broken deck).
                  break;
                }

                break;
              }

              // Empty result ΓÇö retry if we have attempts left
              lastError = fullText.trim()
                ? 'LLM response could not be parsed into outlines'
                : 'LLM returned empty response';
              log.warn(
                `Outlines attempt ${attempt} diagnostics: textLen=${fullText.length}, outlines=${parsedOutlines.length}, languageDirective=${languageDirective ? 'yes' : 'no'}, preview=${JSON.stringify(fullText.slice(0, 240))}`,
              );

              if (attempt <= MAX_STREAM_RETRIES) {
                log.warn(
                  `Empty outlines (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}), retrying...`,
                );
                // Notify client a retry is happening
                const retryEvent = JSON.stringify({
                  type: 'retry',
                  attempt,
                  maxAttempts: MAX_STREAM_RETRIES + 1,
                });
                controller.enqueue(encoder.encode(`data: ${retryEvent}\n\n`));
              }
            } catch (error) {
              // Client disconnected (AbortError from the now-propagated signal):
              // stop immediately, don't burn retries re-running generation.
              if (req.signal?.aborted) {
                stopHeartbeat();
                return;
              }
              lastError = error instanceof Error ? error.message : String(error);
              log.warn(
                `Outlines stream error detail (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}): ${lastError}`,
              );

              if (attempt <= MAX_STREAM_RETRIES) {
                log.warn(
                  `Stream error (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}), retrying...`,
                  error,
                );
                const retryEvent = JSON.stringify({
                  type: 'retry',
                  attempt,
                  maxAttempts: MAX_STREAM_RETRIES + 1,
                });
                controller.enqueue(encoder.encode(`data: ${retryEvent}\n\n`));
                continue;
              }
            }
          }
          }

          if (finalBlueprint) {
            // Contract path: the deck satisfied the blueprint contract. The
            // outlines carry lessonId and the done event carries the blueprint
            // for downstream job-model/UI consumers.
            //
            // Pillar 3b: attach per-scene retrieval context from the full
            // source text (the outline stage is the one place the raw text
            // exists), so scene content can cite the actual source instead of
            // a global summary. With a document handle the chunks come from
            // the server-side index — the ENTIRE document, not a truncated
            // prefix.
            const retrievalChunks: PdfChunk[] = indexChunks.length > 0
              ? indexChunks
              : pdfText && pdfText.length > 2000
                ? chunkSourceText(pdfText)
                : [];
            const doneOutlines = finalBlueprint.lessons.flatMap((lesson) =>
              lesson.outlines.map((outline) => {
                if (outline.retrievalContext || retrievalChunks.length === 0) return outline;
                const query = `${outline.title}\n${outline.description}\n${(outline.keyPoints ?? []).join('\n')}`;
                const retrieved = retrieveChunks(query, retrievalChunks);
                if (retrieved.length === 0) return outline;
                return { ...outline, retrievalContext: formatRetrievalContext(retrieved) };
              }),
            );
            const doneEvent = JSON.stringify({
              type: 'done',
              outlines: doneOutlines,
              languageDirective: finalBlueprint.languageDirective,
              courseTitle: finalBlueprint.title,
              taskEngineMode,
              // Keep the blueprint consistent with the emitted outlines:
              // retrieval context is attached to both, so persisted
              // blueprint projections never lose the source grounding.
              blueprint: {
                ...finalBlueprint,
                lessons: finalBlueprint.lessons.map((lesson) => ({
                  ...lesson,
                  outlines: lesson.outlines.map(
                    (outline) => doneOutlines.find((o) => o.id === outline.id) ?? outline,
                  ),
                })),
              },
            });
            controller.enqueue(encoder.encode(`data: ${doneEvent}\n\n`));

            // Coverage audit (§16): sections of the source document that no
            // lesson cites are reported, not silently dropped. The client
            // surfaces the report (gap-fill or intentional exclusion).
            if (storedIndex && storedIndex.digest.sections.length > 0) {
              const citedMarkers = collectCitedMarkers(doneOutlines);
              const audit = auditDigestCoverage(
                storedIndex.digest,
                indexChunks,
                citedMarkers,
              );
              const coverageEvent = JSON.stringify({
                type: 'coverage',
                data: {
                  report: renderCoverageReport(audit),
                  coverageRatio: audit.coverageRatio,
                  gapCount: audit.gaps.length,
                  uncoveredChapters: audit.uncoveredChapters,
                  trimmedTopics: trimmedDigestTopics,
                },
              });
              controller.enqueue(encoder.encode(`data: ${coverageEvent}\n\n`));
            }
          } else if (parsedOutlines.length > 0 && !contractFailed) {
            // Replace sequential gen_img_N/gen_vid_N with globally unique IDs
            const uniquifiedOutlines = uniquifyMediaElementIds(parsedOutlines);
            // Send done event with all outlines
            const doneEvent = JSON.stringify({
              type: 'done',
              outlines: uniquifiedOutlines,
              languageDirective: languageDirective || DEFAULT_LANGUAGE_DIRECTIVE,
              courseTitle: courseTitle || undefined,
              taskEngineMode,
            });
            controller.enqueue(encoder.encode(`data: ${doneEvent}\n\n`));
          } else {
            // All retries exhausted (no outlines, or the contract was never
            // satisfied ΓÇö never accept a broken deck).
            log.error(
              `Outline generation failed after ${MAX_STREAM_RETRIES + 1} attempts: ${lastError}`,
            );
            const errorEvent = JSON.stringify({
              type: 'error',
              error:
                lastError ||
                (contractFailed
                  ? 'Generated deck did not meet the course contract'
                  : 'Failed to generate outlines'),
            });
            controller.enqueue(encoder.encode(`data: ${errorEvent}\n\n`));
          }
        } catch (error) {
          const errorEvent = JSON.stringify({
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          controller.enqueue(encoder.encode(`data: ${errorEvent}\n\n`));
        } finally {
          stopHeartbeat();
          // The controller may already be closed if the client disconnected.
          try {
            controller.close();
          } catch {
            // already closed ΓÇö ignore
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    log.error(
      `Outline streaming failed [requirement="${requirementSnippet ?? 'unknown'}...", model=${resolvedModelString ?? 'unknown'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
