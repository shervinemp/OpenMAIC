/**
 * Point quiz items at the teaching scene that covers them.
 *
 * The link is computed from the outlines the course already has, not from a
 * model call: a question's concept tags are matched against the preceding
 * outlines' key points, title, and objective. An outline id is stored rather
 * than a scene id because content generation is per scene and the teaching
 * scene may not exist yet; the review UI resolves the outline to its live
 * scene when the learner clicks.
 *
 * The matcher is deliberately conservative. A false link sends a learner to an
 * unrelated lesson, which is worse than no link, so a candidate must share a
 * concept phrase or a content token before it can win.
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
  const preceding = allOutlines.filter(
    (outline) =>
      outline.id !== quizOutline.id &&
      outline.order < quizOutline.order &&
      TEACHING_TYPES.has(outline.type),
  );
  if (preceding.length === 0) {
    return questions.map((question) => ({ ...question, remediationOutlineId: undefined }));
  }

  // Same-lesson candidates win when the outline carries lesson membership;
  // a quiz in lesson 3 should not link back to lesson 1 just because the
  // wording is closer.
  const sameLesson = quizOutline.lessonId
    ? preceding.filter((outline) => outline.lessonId === quizOutline.lessonId)
    : [];
  const pool = sameLesson.length > 0 ? sameLesson : preceding;
  const candidates = pool.map((outline) => {
    const text = candidateText(outline);
    return { outline, text, tokenSet: new Set(tokens(text)) };
  });

  return questions.map((question) => {
    const concepts = (question.concepts ?? []).filter((concept) => concept.trim().length > 0);
    if (concepts.length === 0) return { ...question, remediationOutlineId: undefined };

    let best: { id: string; score: number; order: number } | undefined;
    for (const candidate of candidates) {
      const score = concepts.reduce(
        (total, concept) => total + scoreConcept(concept, candidate.text, candidate.tokenSet),
        0,
      );
      if (score <= 0) continue;
      if (
        !best ||
        score > best.score ||
        (score === best.score && candidate.outline.order > best.order)
      ) {
        best = { id: candidate.outline.id, score, order: candidate.outline.order };
      }
    }

    return { ...question, remediationOutlineId: best?.id };
  });
}
