/**
 * Point assessment items at the teaching scene that covers them.
 *
 * The link is computed from the outlines the course already has, not from a
 * model call: an item's concept tags are matched against the candidate
 * outlines' key points, title, and objective. An outline id is stored rather
 * than a scene id because content generation is per scene and the teaching
 * scene may not exist yet; the review UI resolves the outline to its live
 * scene when the learner clicks.
 *
 * The matcher is deliberately conservative. A false link sends a learner to an
 * unrelated lesson, which is worse than no link, so a candidate must share a
 * concept phrase or a content token before it can win. Exam items use a
 * stricter threshold than quiz items because their pool is not tied to one
 * lesson's preceding outlines.
 */

import type { QuizQuestion } from '@openmaic/dsl';

import type { SceneOutline } from './outline-types.js';

/** Kinds that teach; assessments and interactive widgets are not remediation. */
const TEACHING_TYPES: ReadonlySet<SceneOutline['type']> = new Set([
  'slide',
  'exercise',
  'derivation',
  'glossary',
  'reading',
  'comparison',
  'dataReading',
  'tradeoffs',
]);

const STOPWORDS: ReadonlySet<string> = new Set([
  'and',
  'are',
  'but',
  'can',
  'for',
  'from',
  'has',
  'have',
  'how',
  'into',
  'its',
  'not',
  'that',
  'the',
  'their',
  'then',
  'they',
  'this',
  'use',
  'using',
  'was',
  'were',
  'what',
  'when',
  'why',
  'will',
  'with',
  'you',
  'your',
]);

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokens(value: string): string[] {
  return normalizeText(value)
    .split(/[^\w\u00c0-\u024f\u4e00-\u9fff]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

/**
 * Prefix matching catches the common inflection ("recursion" / "recursive")
 * without a stemmer. Five shared characters is the shortest useful stem for
 * English content terms; shorter prefixes would pair unrelated words.
 */
function sharesStem(left: string, right: string): boolean {
  if (left === right) return true;
  const length = Math.min(6, left.length, right.length);
  return length >= 5 && left.slice(0, length) === right.slice(0, length);
}

function scoreConcept(
  concept: string,
  candidateText: string,
  candidateTokens: Set<string>,
): number {
  const phrase = normalizeText(concept);
  if (!phrase) return 0;

  let score = candidateText.includes(phrase) ? 3 : 0;
  const conceptTokens = tokens(concept);
  if (conceptTokens.length === 0) return score;

  let matched = 0;
  for (const token of conceptTokens) {
    for (const candidateToken of candidateTokens) {
      if (sharesStem(token, candidateToken)) {
        matched += 1;
        break;
      }
    }
  }
  return score + matched / conceptTokens.length;
}

function candidateText(outline: SceneOutline): string {
  return normalizeText(
    [outline.title, outline.description, outline.teachingObjective, ...(outline.keyPoints ?? [])]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' '),
  );
}

export interface OutlineRemediationOptions {
  /** Exclude the assessment's own outline. */
  excludeId?: string;
  /** Only candidates with an earlier order are eligible. */
  beforeOrder?: number;
  /** Prefer candidates from this lesson; falls back to all eligible. */
  lessonId?: string;
  /**
   * A candidate must reach this score on at least one concept. The default
   * accepts any positive match; exam remediation passes 1 to require a concept
   * phrase or every content token of one concept.
   */
  minConceptScore?: number;
}

/**
 * Return the items with `remediationOutlineId` set to the best matching
 * teaching outline, or cleared when nothing matches. Input items are not
 * mutated.
 */
export function attachOutlineRemediation<T extends { concepts?: readonly string[] }>(
  items: readonly T[],
  allOutlines: readonly SceneOutline[],
  options: OutlineRemediationOptions = {},
): Array<T & { remediationOutlineId?: string }> {
  const minConceptScore = options.minConceptScore ?? 0;
  const eligible = allOutlines.filter((outline) => {
    if (!TEACHING_TYPES.has(outline.type)) return false;
    if (options.excludeId !== undefined && outline.id === options.excludeId) return false;
    if (options.beforeOrder !== undefined && outline.order >= options.beforeOrder) return false;
    return true;
  });
  if (eligible.length === 0) {
    return items.map((item) => ({ ...item, remediationOutlineId: undefined }));
  }

  // Same-lesson candidates win when the assessment outline carries lesson
  // membership; a quiz in lesson 3 should not link back to lesson 1 just
  // because the wording is closer.
  let pool = eligible;
  if (options.lessonId) {
    const sameLesson = eligible.filter((outline) => outline.lessonId === options.lessonId);
    if (sameLesson.length > 0) pool = sameLesson;
  }
  const candidates = pool.map((outline) => {
    const text = candidateText(outline);
    return { outline, text, tokenSet: new Set(tokens(text)) };
  });

  return items.map((item) => {
    const concepts = (item.concepts ?? []).filter((concept) => concept.trim().length > 0);
    if (concepts.length === 0) return { ...item, remediationOutlineId: undefined };

    let best: { id: string; score: number; order: number } | undefined;
    for (const candidate of candidates) {
      let score = 0;
      let bestConceptScore = 0;
      for (const concept of concepts) {
        const conceptScore = scoreConcept(concept, candidate.text, candidate.tokenSet);
        score += conceptScore;
        if (conceptScore > bestConceptScore) bestConceptScore = conceptScore;
      }
      if (bestConceptScore <= minConceptScore) continue;
      if (
        !best ||
        score > best.score ||
        (score === best.score && candidate.outline.order > best.order)
      ) {
        best = { id: candidate.outline.id, score, order: candidate.outline.order };
      }
    }

    return { ...item, remediationOutlineId: best?.id };
  });
}

/**
 * Return the questions with `remediationOutlineId` set to the best preceding
 * teaching outline (or cleared when nothing matches). Input questions are not
 * mutated.
 */
export function attachQuizRemediation(
  questions: readonly QuizQuestion[],
  quizOutline: SceneOutline,
  allOutlines: readonly SceneOutline[],
): QuizQuestion[] {
  return attachOutlineRemediation(questions, allOutlines, {
    excludeId: quizOutline.id,
    beforeOrder: quizOutline.order,
    lessonId: quizOutline.lessonId,
  });
}

/**
 * Attach a conservative remediation link to exam pool items. The exam pool is
 * generated from the whole covered range rather than one lesson, so the matcher
 * has to reject partial-token coincidences: at least one concept must match a
 * phrase or all of its content tokens.
 */
export function attachExamRemediation<T extends { concepts?: readonly string[] }>(
  items: readonly T[],
  coveredOutlines: readonly SceneOutline[],
): Array<T & { remediationOutlineId?: string }> {
  return attachOutlineRemediation(items, coveredOutlines, { minConceptScore: 1 });
}
