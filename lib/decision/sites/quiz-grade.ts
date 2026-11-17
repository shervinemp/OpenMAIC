/**
 * `quiz-grade` as a decision site.
 *
 * The LLM path returns a score plus a short learner-facing comment. A
 * decision head can produce the score but not the comment, so decision
 * grading returns an empty comment and the UI must hide that block. `triage`
 * only accepts a clear zero or a clear full score; `replace` accepts any
 * bounded score the model reports.
 */

import type { DecisionRequest, DecisionResult, DecisionSiteConfig } from '../types';

export interface QuizDecisionInput {
  question: string;
  userAnswer: string;
  points: number;
  commentPrompt?: string;
}

export function buildQuizDecisionRequest(input: QuizDecisionInput): DecisionRequest {
  const state = [
    `QUESTION:\n${input.question}`,
    input.commentPrompt ? `GRADING GUIDANCE:\n${input.commentPrompt}` : undefined,
    `STUDENT ANSWER:\n${input.userAnswer}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join('\n\n');

  return {
    state,
    questions: [
      {
        id: '__score',
        kind: 'score',
        prompt: `Award the answer a score from 0 to ${input.points}.`,
        min: 0,
        max: input.points,
      },
    ],
  };
}

export function quizDecisionInputChars(request: DecisionRequest): number {
  return (
    request.state.length +
    request.questions.reduce((total, question) => total + question.prompt.length, 0)
  );
}

export function quizGradeFromResult(
  result: DecisionResult,
  input: QuizDecisionInput,
  config: DecisionSiteConfig,
): { value: { score: number; comment: string }; confidence: number } | null {
  const answer = result.answers.get('__score');
  if (!answer || answer.kind !== 'score') return null;

  const score = Math.max(0, Math.min(input.points, Math.round(answer.value)));
  if (config.mode === 'triage' && score !== 0 && score !== input.points) {
    return null;
  }

  return { value: { score, comment: '' }, confidence: answer.confidence };
}

export function compareQuizGrades(
  decision: { score: number },
  baseline: { score: number },
): boolean {
  return decision.score === baseline.score;
}
