/**
 * `exam-grading` as a decision site.
 *
 * A rubric is already a set of typed questions: each criterion is a yes/no,
 * and the overall score is a bounded number. That makes exam grading the
 * highest-value target for a decision model — provided the layer stays
 * conservative:
 *
 *   triage  — only all-met (full marks) or all-unmet (zero) at high confidence
 *   replace — any per-criterion result plus the model's overall score
 *
 * Feedback text is deliberately empty. A decision head cannot write the
 * rationale the LLM grader writes, so the UI still has the per-criterion
 * verdicts and the sample answer; it must not receive invented prose.
 */

import type { ExamFrGrade } from '@/lib/types/exam';
import type { RubricCriterion } from '@/lib/types/generation';

import type {
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  DecisionSiteConfig,
} from '../types';

export interface ExamDecisionInput {
  questionId?: string;
  prompt: string;
  userAnswer: string;
  rubric: RubricCriterion[];
  sampleAnswer?: string;
  maxPoints: number;
  commentPrompt?: string;
  includeCriteria: boolean;
}

/**
 * The prompt uses `id=${c.id ?? i}` (a zero-based index when the rubric has no
 * id) and the LLM echoes that id back in `criteria`. Synthesizing a different
 * label here (`criterion-0`) made every id-less rubric look like a shadow
 * disagreement, so the fallback must be the same index the prompt shows.
 */
function criterionId(criterion: RubricCriterion, index: number): string {
  const raw = (criterion as { id?: unknown }).id;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : String(index);
}

export function buildExamDecisionRequest(input: ExamDecisionInput): DecisionRequest | null {
  // Without per-criterion output there is no safe way to derive a score from a
  // handful of probabilities; leave those calls entirely to the LLM.
  if (!input.includeCriteria || input.rubric.length === 0) return null;

  const state = [
    `QUESTION:\n${input.prompt}`,
    `STUDENT ANSWER:\n${input.userAnswer}`,
    input.sampleAnswer
      ? `STRONG MODEL ANSWER (calibration only; do not penalize different wording):\n${input.sampleAnswer}`
      : undefined,
    `GRADING GUIDANCE:\n${input.commentPrompt ?? 'none'}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join('\n\n');

  const questions: DecisionQuestion[] = [];
  // `__score` is reserved for the overall score; a rubric criterion must not
  // be able to shadow it with the same id.
  const seenIds = new Set<string>(['__score']);
  for (let index = 0; index < input.rubric.length; index += 1) {
    const criterion = input.rubric[index]!;
    const id = criterionId(criterion, index);
    // A duplicate id would make two criteria share one answer; the LLM path
    // can still produce a usable grade, so skip the decision layer instead.
    if (seenIds.has(id)) return null;
    seenIds.add(id);
    questions.push({
      id,
      kind: 'noul',
      prompt: `${criterion.criterion} — looks for: ${criterion.lookFor ?? 'the criterion is satisfied'}`,
    });
  }

  questions.push({
    id: '__score',
    kind: 'score',
    prompt: `Award the whole answer a score from 0 to ${input.maxPoints}.`,
    min: 0,
    max: input.maxPoints,
  });

  return { state, questions };
}

export function examDecisionInputChars(request: DecisionRequest): number {
  return (
    request.state.length +
    request.questions.reduce((total, question) => total + question.prompt.length, 0)
  );
}

export function examGradeFromResult(
  result: DecisionResult,
  input: ExamDecisionInput,
  config: DecisionSiteConfig,
): { value: ExamFrGrade; confidence: number } | null {
  if (input.rubric.length === 0) return null;

  const met: Array<{ id: string; met: boolean; probability: number }> = [];
  let confidence = 1;

  for (let index = 0; index < input.rubric.length; index += 1) {
    const criterion = input.rubric[index]!;
    const id = criterionId(criterion, index);
    const answer = result.answers.get(id);
    if (!answer || answer.kind !== 'noul') return null;
    met.push({ id, met: answer.probability >= 0.5, probability: answer.probability });
    confidence = Math.min(confidence, answer.confidence);
  }

  // A probability of exactly 0.5 is a coin flip, not a verdict. Treat it as
  // partial in triage instead of awarding full marks (or zero) on it.
  const allMet = met.every((entry) => entry.probability > 0.5);
  const noneMet = met.every((entry) => entry.probability < 0.5);

  let score: number;
  if (allMet) {
    score = input.maxPoints;
  } else if (noneMet) {
    score = 0;
  } else if (config.mode === 'replace' || config.mode === 'shadow') {
    const scoreAnswer = result.answers.get('__score');
    if (!scoreAnswer || scoreAnswer.kind !== 'score') return null;
    score = Math.round(scoreAnswer.value);
    confidence = Math.min(confidence, scoreAnswer.confidence);
  } else {
    // A partial answer needs the LLM's judgement; triage must not guess.
    return null;
  }

  return {
    value: {
      questionId: input.questionId ?? '',
      score: Math.max(0, Math.min(input.maxPoints, score)),
      maxPoints: input.maxPoints,
      comment: '',
      criteria: met.map((entry) => ({ id: entry.id, met: entry.met, comment: '' })),
    },
    confidence,
  };
}

export function compareExamGrades(decision: ExamFrGrade, baseline: ExamFrGrade): boolean {
  if (decision.score !== baseline.score) return false;
  const baselineCriteria = new Map(
    (baseline.criteria ?? []).map((criterion) => [criterion.id, criterion.met]),
  );
  const decisionCriteria = decision.criteria ?? [];
  if (decisionCriteria.length !== baselineCriteria.size) return false;
  return decisionCriteria.every(
    (criterion) => baselineCriteria.get(criterion.id) === criterion.met,
  );
}
