/**
 * `quiz-verify` as a decision site.
 *
 * The existing `QuizAnswerVerifier` contract is already the right shape —
 * blind questions in, option values out — so the decision layer slots in
 * without touching the quiz generation loop. Partial answers are legal: an
 * abstained or low-confidence item simply produces no signal, exactly like a
 * missing LLM verdict.
 */

import type {
  QuizAnswerVerifier,
  QuizVerificationAnswer,
  QuizVerificationQuestion,
} from '@openmaic/generation';

import { runDecisionSite } from '../router';
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  DecisionSiteConfig,
} from '../types';

function buildRequest(questions: readonly QuizVerificationQuestion[]): DecisionRequest {
  return {
    state:
      'Blind multiple-choice solve. Each item is independent; use only its stem and options. No answer key is provided.',
    questions: questions.map((question) => ({
      id: question.id,
      kind: 'choice' as const,
      prompt: `${question.question}\n\n${question.options
        .map((option) => `${option.value}. ${option.label}`)
        .join('\n')}`,
      options: question.options,
      multiple: question.type === 'multiple',
    })),
  };
}

function inputChars(request: DecisionRequest): number {
  // `buildRequest` already renders the options into each prompt. Counting the
  // option labels again nearly doubled the measured input and made long but
  // valid quizzes skip the decision model.
  return (
    request.state.length +
    request.questions.reduce((total, question) => total + question.prompt.length, 0)
  );
}

function answersFromResult(
  result: DecisionResult,
  questions: readonly QuizVerificationQuestion[],
): { value: QuizVerificationAnswer[]; confidence: number } | null {
  const answers: QuizVerificationAnswer[] = [];
  let confidence = 1;

  for (const question of questions) {
    const answer = result.answers.get(question.id);
    if (!answer || answer.kind !== 'choice') continue;
    const allowed = new Set(question.options.map((option) => option.value));
    const values = answer.values.filter((value) => allowed.has(value));
    const selected = question.type === 'single' ? values.slice(0, 1) : values;
    if (selected.length === 0) continue;
    answers.push({ id: question.id, answers: selected });
    confidence = Math.min(confidence, answer.confidence);
  }

  return answers.length > 0 ? { value: answers, confidence } : null;
}

function compareAnswers(
  decision: readonly QuizVerificationAnswer[] | undefined,
  baseline: readonly QuizVerificationAnswer[] | undefined,
): boolean | undefined {
  if (!decision || !baseline) return undefined;
  const normalize = (answers: readonly QuizVerificationAnswer[]) =>
    new Map(answers.map((answer) => [answer.id, [...answer.answers].sort().join(',')]));
  const left = normalize(decision);
  const right = normalize(baseline);
  if (left.size !== right.size) return false;
  for (const [id, value] of left) {
    if (right.get(id) !== value) return false;
  }
  return true;
}

export interface DecisionQuizVerifierOptions {
  config: DecisionSiteConfig;
  /** The existing LLM verifier, when a `quiz-verify` route is configured. */
  baseline?: QuizAnswerVerifier;
  signal?: AbortSignal;
  /** Test seam: inject a provider instead of constructing one from config. */
  provider?: DecisionProvider;
}

export function createDecisionQuizVerifier(
  options: DecisionQuizVerifierOptions,
): QuizAnswerVerifier {
  return async (questions) => {
    const request = buildRequest(questions);
    const outcome = await runDecisionSite<readonly QuizVerificationAnswer[] | undefined>(
      {
        site: 'quiz-verify',
        inputChars: inputChars(request),
        request,
        baseline: options.baseline
          ? async () => (await options.baseline!(questions)) ?? undefined
          : undefined,
        fromResult: (result) => answersFromResult(result, questions),
        compare: compareAnswers,
        signal: options.signal,
      },
      { config: options.config, provider: options.provider },
    );

    if (outcome.source === 'decision' || outcome.source === 'baseline') {
      return outcome.value;
    }
    return undefined;
  };
}
