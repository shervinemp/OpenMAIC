/**
 * Turn a graded quiz attempt into learning evidence.
 *
 * The adapter is deliberately narrow. It maps results the caller has already
 * graded; it does not decide whether an attempt is trustworthy and it does not
 * accept practice attempts. Practice is an ephemeral rehearsal by product
 * decision, so a practice answer must not create a durable trace of the graded
 * attempt or change its score. A caller that later wants practice evidence
 * should add an explicit source and keep it separate from the graded record.
 *
 * Short answers can earn partial credit. The quiz UI marks them `correct` above
 * an 80% threshold, but `earned` retains the real fraction, so the adapter
 * prefers `earned / points` whenever the caller supplies the item's worth.
 * Status is the fallback for items whose points are unknown.
 */

import { normalizeConceptTags } from '@openmaic/dsl';
import { quizQuestionPoints, type QuestionResult } from '@/lib/quiz/grading';
import type { QuizQuestion } from '@/lib/types/stage';

import type { ConceptId, LearningEvidence } from './types';

export interface QuizEvidenceItem {
  questionId: string;
  /** Concepts this question measures. Missing tags leave the item untagged. */
  conceptIds?: readonly ConceptId[];
  /** Points the question is worth, used to preserve partial credit. */
  points?: number;
}

export interface QuizEvidenceInput {
  learnerKey: string;
  stageId: string;
  sceneId: string;
  attemptId: string;
  /** Epoch milliseconds shared by every record from this submission. */
  recordedAt: number;
  items: readonly QuizEvidenceItem[];
  results: readonly QuestionResult[];
}

/**
 * Build the item descriptions the adapter needs from the quiz content.
 *
 * Tags are normalized here, not at generation time alone, because imported
 * classrooms and hand-edited scenes can carry the same field with sloppy
 * casing. Points use the same default the UI and grader use, so an untagged
 * `points` value does not change the denominator of partial credit.
 */
export function quizEvidenceItems(questions: readonly QuizQuestion[]): QuizEvidenceItem[] {
  return questions.map((question) => {
    const item: QuizEvidenceItem = {
      questionId: question.id,
      points: quizQuestionPoints(question.points),
    };
    const conceptIds = normalizeConceptTags(question.concepts);
    if (conceptIds) item.conceptIds = conceptIds;
    return item;
  });
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function scoreFor(result: QuestionResult, points: number | undefined): number {
  if (result.status === 'ungraded') return 0;
  if (
    typeof points === 'number' &&
    Number.isFinite(points) &&
    points > 0 &&
    Number.isFinite(result.earned)
  ) {
    return clamp01(result.earned / points);
  }
  return result.status === 'correct' ? 1 : 0;
}

/**
 * One record per result whose question the caller described. Results for
 * unknown questions are skipped rather than guessed at; a stale result must not
 * create evidence for an item that no longer exists in the course.
 */
export function evidenceFromQuizAttempt(input: QuizEvidenceInput): LearningEvidence[] {
  const items = new Map(input.items.map((item) => [item.questionId, item]));
  const evidence: LearningEvidence[] = [];

  for (const result of input.results) {
    const item = items.get(result.questionId);
    if (!item) continue;
    const outcome = result.status === 'ungraded' ? 'ungraded' : 'graded';
    evidence.push({
      // One submission is one observation per question. Replaying the same
      // submission is idempotent in the log; a retake has a new attempt id.
      id: `${input.stageId}:quiz:${input.sceneId}:${input.attemptId}:${result.questionId}`,
      learnerKey: input.learnerKey,
      stageId: input.stageId,
      itemId: result.questionId,
      conceptIds: item.conceptIds ?? [],
      source: 'quiz',
      score: outcome === 'ungraded' ? 0 : scoreFor(result, item.points),
      outcome,
      recordedAt: input.recordedAt,
    });
  }

  return evidence;
}
