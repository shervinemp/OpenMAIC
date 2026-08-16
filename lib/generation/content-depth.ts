/**
 * Content Depth Contract (Pillar 3) — scenes must teach, not decorate.
 *
 * Real generated decks parse as valid while containing caption fragments
 * ("Bronze tables", "Raw files") and generic narration. This module gives
 * scene content a minimum-substance contract:
 *
 * - a caption detector (short noun phrases without a verb),
 * - a claim detector (complete sentences / verb + object structure),
 * - per-type minimums (slides: ≥4 substantive elements, captions may not
 *   dominate, ≥1 concrete example unless intro/summary; quizzes: the
 *   configured question count with substantive stems, plausible
 *   distractors, and explanations),
 * - a bounded corrective loop is driven by the callers in
 *   scene-generator.ts, which re-prompt with `summarizeDepthFindings`.
 *
 * On final exhaustion the content is rejected (null) and the report is
 * recorded via `recordSceneDepthReport` so the job model/UI can surface
 * why the scene failed.
 */

import type { PPTElement, QuizQuestion } from '@openmaic/dsl';
import {
  COURSE_DEPTH_FLOORS,
  SPECIALTY_DEPTH_FLOORS,
  resolveDepthLevel,
  type CourseDepthLevel,
} from '@/lib/constants/generation';
import { extractCitationMarkers } from './pdf-retrieval';
import type {
  SceneOutline,
  ExerciseProblem,
  DerivationStep,
  GlossaryTerm,
  ReadingItem,
} from '@/lib/types/generation';

// ==================== Report ====================

export interface DepthReport {
  /** The content meets the contract and can be accepted. */
  adequate: boolean;
  /** False when the validator had nothing to check (non-slide/quiz type). */
  depthValidated: boolean;
  totalTextElements: number;
  substantiveCount: number;
  captionCount: number;
  exampleCount: number;
  findings: string[];
}

export interface SlideDepthOptions {
  /** Minimum substantive text elements (default: the depth level's floor). */
  minSubstantive?: number;
  /** Require ≥1 concrete example/definition/fact (default true). */
  requireExample?: boolean;
  /**
   * Per-scene retrieval context (rendered `[source p.N]` chunks). When
   * present, the content must cite ≥ the floor's minimum of its markers
   * and may not cite anything outside the retrieved set (no hallucinated
   * citations).
   */
  retrievalContext?: string;
  /**
   * Content depth level (Phase 2 §15.4). Raises the substantive floor and
   * the citation minimum; 'intro' keeps today's behavior.
   */
  depthLevel?: CourseDepthLevel;
}

/** Citation ground-truth checks shared by slide and quiz validation. */
function citationFindings(
  combinedText: string,
  retrievalContext: string,
  minCitations = 2,
): string[] {
  const findings: string[] = [];
  const cited = extractCitationMarkers(combinedText);
  const retrieved = new Set(extractCitationMarkers(retrievalContext));

  if (cited.length < minCitations) {
    findings.push(
      `content cites ${cited.length} source marker(s) — cite at least ${minCitations} [source p.N] markers from the retrieved material below`,
    );
  }
  const invalid = cited.filter((marker) => !retrieved.has(marker));
  if (invalid.length > 0) {
    findings.push(
      `content cites source markers not present in the retrieved material: ${invalid.join(', ')} — only cite markers listed in the retrieval context`,
    );
  }
  return findings;
}

// ==================== Text heuristics ====================

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// Common verb stems (present/past/3rd-person). A phrase containing one of
// these reads as a claim, not a label.
const VERB_RE =
  /\b(is|are|was|were|be|been|being|am|have|has|had|do|does|did|will|would|can|could|should|may|might|must|use|uses|using|used|make|makes|making|create|creates|creating|provide|provides|providing|allow|allows|enable|enables|show|shows|showing|represent|represents|convert|converts|transform|transforms|contain|contains|hold|holds|store|stores|define|defines|describe|describes|explain|explains|declare|declares|become|becomes|produce|produces|run|runs|return|returns|support|supports|include|includes|process|processes|move|moves|change|changes|require|requires|need|needs|take|takes|give|gives|learn|learns|teach|teaches)\b/i;

const EXAMPLE_RE = /\b(example|examples|e\.g\.|for instance|举例|例如|例子|示例|比如|比如说)\b/i;

const INTRO_SUMMARY_RE =
  /\b(intro|introduction|overview|welcome|agenda|summary|conclusion|recap|review|wrap[- ]?up|outro|closing|总结|回顾|概述|引言|小结|引入|收尾)\b/i;

/**
 * A caption is a short noun phrase with no verb (≤ 6 words) — a label,
 * not a claim ("Bronze tables", "Raw files").
 */
export function isCaptionText(text: string): boolean {
  const words = wordCount(text);
  if (words === 0 || words > 6) return false;
  return !VERB_RE.test(text);
}

/**
 * A substantive element is a complete sentence (≥ 40 chars of
 * non-whitespace) or a verb-carrying phrase of ≥ 5 words.
 */
export function isSubstantiveText(text: string): boolean {
  if (text.replace(/\s+/g, '').length >= 40) return true;
  return wordCount(text) >= 5 && VERB_RE.test(text);
}

/**
 * Intro/outro outlines legitimately summarize — they are exempt from the
 * example/claim requirements (but never from the caption detector).
 */
export function isIntroSummaryOutline(outline: SceneOutline): boolean {
  const title = (outline.title || '').toLowerCase();
  return INTRO_SUMMARY_RE.test(title) || INTRO_SUMMARY_RE.test(outline.description || '');
}

// ==================== Slide validation ====================

export function extractSlideTexts(elements: PPTElement[]): string[] {
  const texts: string[] = [];
  for (const element of elements) {
    if (element.type === 'text') {
      const content = (element as { content?: unknown }).content;
      if (typeof content === 'string') {
        const stripped = stripHtml(content);
        if (stripped) texts.push(stripped);
      }
    }
  }
  return texts;
}

export function validateSlideDepth(
  outline: SceneOutline,
  elements: PPTElement[],
  options: SlideDepthOptions = {},
): DepthReport {
  const depthLevel = resolveDepthLevel(options.depthLevel ?? outline.depthLevel);
  const floor = COURSE_DEPTH_FLOORS[depthLevel];
  const minSubstantive = options.minSubstantive ?? floor.minSubstantive;
  const requireExample = options.requireExample ?? true;
  const retrievalContext = options.retrievalContext;

  const texts = extractSlideTexts(elements);
  const total = texts.length;
  let substantiveCount = 0;
  let captionCount = 0;
  let exampleCount = 0;
  const captionSamples: string[] = [];

  for (const text of texts) {
    if (EXAMPLE_RE.test(text)) exampleCount++;
    if (isSubstantiveText(text)) {
      substantiveCount++;
    } else if (isCaptionText(text)) {
      captionCount++;
      if (captionSamples.length < 3) captionSamples.push(text);
    }
  }

  const findings: string[] = [];

  if (total === 0) {
    findings.push('the slide has no text elements — add at least one substantive sentence');
  } else {
    if (captionCount >= substantiveCount) {
      findings.push(
        `${captionCount} of ${total} text elements are caption fragments (e.g. "${captionSamples.join('", "')}") — write complete sentences that make claims, not noun labels`,
      );
    }
    if (substantiveCount < minSubstantive) {
      findings.push(
        `only ${substantiveCount} substantive text element(s) (complete claims/sentences); need at least ${minSubstantive}`,
      );
    }
  }

  if (requireExample && exampleCount === 0 && !isIntroSummaryOutline(outline) && total > 0) {
    findings.push(
      'no concrete example, definition, or fact — add at least one (a worked example or a real number)',
    );
  }

  if (retrievalContext) {
    findings.push(...citationFindings(texts.join(' '), retrievalContext, floor.minCitations));
  }

  return {
    adequate: findings.length === 0,
    depthValidated: true,
    totalTextElements: total,
    substantiveCount,
    captionCount,
    exampleCount,
    findings,
  };
}

// ==================== Quiz validation ====================

export function validateQuizDepth(
  outline: SceneOutline,
  questions: QuizQuestion[],
  retrievalContext?: string,
): DepthReport {
  const depthLevel = resolveDepthLevel(outline.depthLevel);
  const floor = COURSE_DEPTH_FLOORS[depthLevel];
  const findings: string[] = [];
  let substantiveCount = 0;

  const target = outline.quizConfig?.questionCount;
  if (target != null && questions.length !== target) {
    findings.push(`quiz has ${questions.length} questions, but the outline target is ${target}`);
  }

  for (const question of questions) {
    const stem = (question.question || '').trim();
    const words = wordCount(stem);
    const bareRecall = /^what is ([a-z0-9 ]+)\??$/i.test(stem) || /^什么是.*[？?]?$/.test(stem);

    if (!stem) {
      findings.push(`question "${question.id}" has an empty stem`);
    } else if (words <= 4 || bareRecall) {
      findings.push(
        `question "${question.id}" stem is a bare recall prompt ("${stem.slice(0, 60)}") — phrase a concrete scenario`,
      );
    } else {
      substantiveCount++;
    }

    if (question.type !== 'short_answer') {
      const optionCount = question.options?.length ?? 0;
      if (optionCount < floor.minOptions) {
        findings.push(
          `question "${question.id}" has ${optionCount} option(s); need at least ${floor.minOptions} plausible distractors`,
        );
      }
      if (!question.analysis || !question.analysis.trim()) {
        findings.push(`question "${question.id}" is missing the explanation (analysis) field`);
      }
    }
  }

  if (retrievalContext) {
    const combinedText = questions
      .map((q) => `${q.question} ${q.analysis ?? ''} ${(q.options ?? []).map((o) => o.label).join(' ')}`)
      .join(' ');
    findings.push(...citationFindings(combinedText, retrievalContext, floor.minCitations));
  }

  return {
    adequate: findings.length === 0,
    depthValidated: true,
    totalTextElements: questions.length,
    substantiveCount,
    captionCount: 0,
    exampleCount: 0,
    findings,
  };
}

// ==================== Specialized scene validation (Phase 2 §15.4b) ====================
// Exercise / derivation / glossary / reading scenes validate their
// STRUCTURED payload (problems with worked solutions, latex steps with
// explanations, term/definition pairs, annotated reading lists) against
// floors that scale with the course depth level.

function blankFindingsReport(total: number, findings: string[]): DepthReport {
  return {
    adequate: findings.length === 0,
    depthValidated: true,
    totalTextElements: total,
    substantiveCount: 0,
    captionCount: 0,
    exampleCount: 0,
    findings,
  };
}

export function validateExerciseDepth(
  outline: SceneOutline,
  problems: ExerciseProblem[],
  options: { retrievalContext?: string; depthLevel?: CourseDepthLevel } = {},
): DepthReport {
  const depthLevel = resolveDepthLevel(options.depthLevel ?? outline.depthLevel);
  const floor = SPECIALTY_DEPTH_FLOORS[depthLevel];
  const findings: string[] = [];

  const worked = problems.filter((p) => (p.statement || '').trim() && (p.solution || '').trim());
  if (worked.length < floor.minProblems) {
    findings.push(
      `exercise has ${worked.length} fully-worked problem(s); need at least ${floor.minProblems} (each with a concrete statement AND a worked solution)`,
    );
  }
  for (const problem of problems) {
    if (!problem.statement?.trim()) {
      findings.push(`problem "${problem.id}" has an empty statement`);
    } else if (isCaptionText(stripHtml(problem.statement))) {
      findings.push(
        `problem "${problem.id}" statement is a bare fragment ("${problem.statement.slice(0, 60)}") — state the full problem with concrete numbers`,
      );
    }
    if (!problem.solution?.trim()) {
      findings.push(`problem "${problem.id}" is missing the worked solution`);
    }
    if (depthLevel === 'university' && !problem.analysis?.trim()) {
      findings.push(
        `problem "${problem.id}" is missing the analysis field (why the method works / common pitfalls) — required at university depth`,
      );
    }
  }

  if (options.retrievalContext) {
    const combinedText = problems
      .map((p) => `${p.statement} ${p.hint ?? ''} ${p.solution} ${p.analysis ?? ''}`)
      .join(' ');
    findings.push(
      ...citationFindings(combinedText, options.retrievalContext, COURSE_DEPTH_FLOORS[depthLevel].minCitations),
    );
  }

  return blankFindingsReport(worked.length, findings);
}

export function validateDerivationDepth(
  outline: SceneOutline,
  steps: DerivationStep[],
  options: { retrievalContext?: string; depthLevel?: CourseDepthLevel } = {},
): DepthReport {
  const depthLevel = resolveDepthLevel(options.depthLevel ?? outline.depthLevel);
  const floor = SPECIALTY_DEPTH_FLOORS[depthLevel];
  const findings: string[] = [];

  const complete = steps.filter((s) => (s.latex || '').trim() && (s.explanation || '').trim());
  if (complete.length < floor.minDerivationSteps) {
    findings.push(
      `derivation has ${complete.length} complete step(s); need at least ${floor.minDerivationSteps} (each with a formula AND a prose explanation)`,
    );
  }
  for (const step of steps) {
    if (!step.latex?.trim()) {
      findings.push(`derivation step "${step.id}" is missing the latex formula`);
    }
    if (!step.explanation?.trim()) {
      findings.push(`derivation step "${step.id}" is missing the explanation of why the step holds`);
    } else if (isCaptionText(stripHtml(step.explanation))) {
      findings.push(
        `derivation step "${step.id}" explanation is a fragment ("${step.explanation.slice(0, 60)}") — write a complete sentence`,
      );
    }
  }

  if (options.retrievalContext) {
    const combinedText = steps.map((s) => `${s.claim ?? ''} ${s.explanation}`).join(' ');
    findings.push(
      ...citationFindings(combinedText, options.retrievalContext, COURSE_DEPTH_FLOORS[depthLevel].minCitations),
    );
  }

  return blankFindingsReport(complete.length, findings);
}

export function validateGlossaryDepth(
  outline: SceneOutline,
  terms: GlossaryTerm[],
): DepthReport {
  const depthLevel = resolveDepthLevel(outline.depthLevel);
  const floor = SPECIALTY_DEPTH_FLOORS[depthLevel];
  const findings: string[] = [];

  const complete = terms.filter((t) => (t.term || '').trim() && (t.definition || '').trim());
  if (complete.length < floor.minGlossaryTerms) {
    findings.push(
      `glossary has ${complete.length} complete term(s); need at least ${floor.minGlossaryTerms} (each with a definition)`,
    );
  }
  for (const term of terms) {
    if (!term.term?.trim()) {
      findings.push(`glossary entry is missing the term`);
    }
    if (!term.definition?.trim()) {
      findings.push(`glossary term "${term.term}" is missing its definition`);
    } else if (isCaptionText(stripHtml(term.definition))) {
      findings.push(
        `glossary term "${term.term}" definition is a fragment ("${term.definition.slice(0, 60)}") — write a complete definition`,
      );
    }
  }

  return blankFindingsReport(complete.length, findings);
}

export function validateReadingDepth(
  outline: SceneOutline,
  items: ReadingItem[],
  options: { retrievalContext?: string; depthLevel?: CourseDepthLevel } = {},
): DepthReport {
  const depthLevel = resolveDepthLevel(options.depthLevel ?? outline.depthLevel);
  const floor = SPECIALTY_DEPTH_FLOORS[depthLevel];
  const findings: string[] = [];

  const complete = items.filter((i) => (i.title || '').trim() && (i.whyRead || '').trim());
  if (complete.length < floor.minReadingItems) {
    findings.push(
      `reading list has ${complete.length} complete item(s); need at least ${floor.minReadingItems} (each with a title AND a why-read annotation)`,
    );
  }
  for (const item of items) {
    if (!item.title?.trim()) {
      findings.push(`reading item is missing the title`);
    }
    if (!item.whyRead?.trim()) {
      findings.push(`reading item "${item.title}" is missing the why-read annotation`);
    }
  }

  return blankFindingsReport(complete.length, findings);
}

// ==================== Corrective feedback ====================

export function summarizeDepthFindings(report: DepthReport): string {
  return [
    'The generated content did NOT meet the depth contract:',
    ...report.findings.map((finding) => `- ${finding}`),
    'Revise the content to fix every finding above and return the corrected JSON. Do not shorten existing substantive content.',
  ].join('\n');
}

// ==================== Failure side channel ====================
// On corrective-loop exhaustion the content is rejected; the report is
// recorded here so the job model (Pillar 2) and the UI can surface why a
// scene failed instead of a black box. Replaced by per-phase job state as
// the generator loop migrates.

const sceneDepthReports = new Map<string, DepthReport>();

export function recordSceneDepthReport(outlineId: string, report: DepthReport): void {
  sceneDepthReports.set(outlineId, report);
}

export function takeSceneDepthReport(outlineId: string): DepthReport | undefined {
  const report = sceneDepthReports.get(outlineId);
  if (report) sceneDepthReports.delete(outlineId);
  return report;
}

// ==================== Success side channel (depth affordance) ====================
// Successful scenes that needed corrective re-prompting also record a
// summary, so the UI can show "reworked for depth" instead of presenting
// every accepted scene as first-try output.

export interface SceneDepthSummary {
  /** The content needed ≥1 corrective re-prompt before passing the contract. */
  reworked: boolean;
  /** Content-generation attempts used (1 = first-try acceptance). */
  attempts: number;
  /** Findings from the final (adequate) pass — empty when first-try. */
  findings: string[];
}

const sceneDepthSummaries = new Map<string, SceneDepthSummary>();

export function recordSceneDepthSummary(outlineId: string, summary: SceneDepthSummary): void {
  sceneDepthSummaries.set(outlineId, summary);
}

export function takeSceneDepthSummary(outlineId: string): SceneDepthSummary | undefined {
  const summary = sceneDepthSummaries.get(outlineId);
  if (summary) sceneDepthSummaries.delete(outlineId);
  return summary;
}
