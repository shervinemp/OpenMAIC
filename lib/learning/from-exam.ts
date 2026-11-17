/**
 * Turn one graded exam attempt into learning evidence.
 *
 * The adapter is deliberately narrow, like the quiz bridge: it maps results the
 * caller already has and never invents a grade. A missing MC result or a
 * missing free-response grade is `ungraded`, not zero; mastery and review both
 * skip it.
 *
 * Only items on the attempt's drawn form are considered. Stored results for a
 * question that is no longer on the form (a regenerated pool, a stale legacy
 * attempt) are ignored rather than attributed to a different question.
 *
 * Exam items do not create review cards. They live in a pool with no owning
 * scene, so there is no stable "review this lesson" destination yet; evidence
 * still feeds concept mastery.
 */

import { normalizeConceptTags } from '@openmaic/dsl';

import type { ExamAttempt, ExamChoiceQuestion, ExamFreeResponse } from '@/lib/types/exam';

import type { LearningEvidence } from './types';

/** The drawn form, not the whole pool. */
export interface ExamEvidenceVariant {
  mcQuestions: readonly ExamChoiceQuestion[];
  frQuestions: readonly ExamFreeResponse[];
}

export interface ExamEvidenceInput {
  learnerKey: string;
  stageId: string;
  attempt: ExamAttempt;
  variant: ExamEvidenceVariant;
  /** Epoch milliseconds shared by every record from this submission. */
  recordedAt: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function conceptIds(question: { concepts?: string[] }): string[] {
  return normalizeConceptTags(question.concepts) ?? [];
}

function evidenceId(
  stageId: string,
  attempt: ExamAttempt,
  section: 'mc' | 'fr',
  itemId: string,
): string {
  // One submission is one observation per item. A retake has a new attempt id,
  // so replaying the same attempt is idempotent but a retake still counts.
  return `${stageId}:exam:${attempt.kind}:${attempt.id}:${section}:${itemId}`;
}

function baseRecord(
  input: ExamEvidenceInput,
  section: 'mc' | 'fr',
  itemId: string,
  concepts: string[],
) {
  return {
    id: evidenceId(input.stageId, input.attempt, section, itemId),
    learnerKey: input.learnerKey,
    stageId: input.stageId,
    itemId,
    conceptIds: concepts,
    source: 'exam' as const,
    recordedAt: input.recordedAt,
  };
}

/** MC is auto-graded; `earned` is the authoritative partial-credit value. */
function mcEvidence(input: ExamEvidenceInput, question: ExamChoiceQuestion): LearningEvidence {
  const result = input.attempt.mcResults?.[question.id];
  const points = positiveNumber(question.points);
  let outcome: LearningEvidence['outcome'] = 'ungraded';
  let score = 0;

  if (result && points !== undefined) {
    const earned = finiteNumber(result.earned) ?? (result.correct ? points : 0);
    outcome = 'graded';
    score = clamp01(earned / points);
  }

  return {
    ...baseRecord(input, 'mc', question.id, conceptIds(question)),
    score,
    outcome,
  };
}

/** FR is rubric-graded; a missing or malformed grade is not a zero. */
function frEvidence(input: ExamEvidenceInput, question: ExamFreeResponse): LearningEvidence {
  const grade = input.attempt.frGrades?.find((entry) => entry.questionId === question.id);
  const maxPoints = positiveNumber(grade?.maxPoints) ?? positiveNumber(question.maxPoints);
  const rawScore = finiteNumber(grade?.score);
  const graded = grade !== undefined && maxPoints !== undefined && rawScore !== undefined;

  return {
    ...baseRecord(input, 'fr', question.id, conceptIds(question)),
    score: graded ? clamp01(rawScore / maxPoints) : 0,
    outcome: graded ? 'graded' : 'ungraded',
  };
}

/**
 * One record per item on the drawn form. Items with no usable result are kept
 * as `ungraded` evidence so an outage is visible but never counts as a miss.
 */
export function evidenceFromExamAttempt(input: ExamEvidenceInput): LearningEvidence[] {
  return [
    ...input.variant.mcQuestions.map((question) => mcEvidence(input, question)),
    ...input.variant.frQuestions.map((question) => frEvidence(input, question)),
  ];
}
