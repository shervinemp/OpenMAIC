import type { QuestionResult } from './grading';

/** Aggregate view of one practice run. Mirrors the review banner's rules. */
export interface PracticeSummary {
  correct: number;
  incorrect: number;
  ungraded: number;
  earned: number;
  /** Points of graded questions only; ungraded questions are not counted. */
  gradedTotal: number;
  /** Questions to retry: anything that was not answered correctly. */
  missed: string[];
}

/**
 * Summarize a practice run. Ungraded questions earn nothing and are excluded
 * from the denominator (a grading outage must not look like a wrong answer),
 * but they ARE offered for another attempt.
 */
export function summarizePractice(
  results: readonly QuestionResult[],
  pointsByQuestion: Readonly<Record<string, number>>,
): PracticeSummary {
  let correct = 0;
  let incorrect = 0;
  let ungraded = 0;
  let earned = 0;
  let gradedTotal = 0;
  const missed: string[] = [];

  for (const result of results) {
    if (result.status === 'correct') {
      correct += 1;
    } else if (result.status === 'incorrect') {
      incorrect += 1;
    } else {
      ungraded += 1;
    }
    if (result.status !== 'correct') missed.push(result.questionId);
    if (result.status !== 'ungraded') {
      earned += result.earned;
      gradedTotal += pointsByQuestion[result.questionId] ?? 1;
    }
  }

  return { correct, incorrect, ungraded, earned, gradedTotal, missed };
}

/** Whether an answer for one question is present and worth checking. */
export function hasPracticeAnswer(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}
