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
import { MIN_SUBSTANTIVE_ELEMENTS } from '@/lib/constants/generation';
import { extractCitationMarkers } from './pdf-retrieval';
import type { SceneOutline } from '@/lib/types/generation';

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
  /** Minimum substantive text elements (default MIN_SUBSTANTIVE_ELEMENTS). */
  minSubstantive?: number;
  /** Require ≥1 concrete example/definition/fact (default true). */
  requireExample?: boolean;
  /**
   * Per-scene retrieval context (rendered `[source p.N]` chunks). When
   * present, the content must cite ≥2 of its markers and may not cite
   * anything outside the retrieved set (no hallucinated citations).
   */
  retrievalContext?: string;
}

/** Citation ground-truth checks shared by slide and quiz validation. */
function citationFindings(combinedText: string, retrievalContext: string): string[] {
  const findings: string[] = [];
  const cited = extractCitationMarkers(combinedText);
  const retrieved = new Set(extractCitationMarkers(retrievalContext));

  if (cited.length < 2) {
    findings.push(
      `content cites ${cited.length} source marker(s) — cite at least two [source p.N] markers from the retrieved material below`,
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
  const minSubstantive = options.minSubstantive ?? MIN_SUBSTANTIVE_ELEMENTS;
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
    findings.push(...citationFindings(texts.join(' '), retrievalContext));
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
      if (optionCount < 2) {
        findings.push(`question "${question.id}" has ${optionCount} option(s); need at least 2 plausible distractors`);
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
    findings.push(...citationFindings(combinedText, retrievalContext));
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
