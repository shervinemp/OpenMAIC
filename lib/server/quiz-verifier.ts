/**
 * Per-request binding for the blind quiz-answer verifier.
 *
 * The `quiz-verify` stage is opt-in and operator-only. Both the scene-content
 * route (scene quizzes) and the exam route (MC keys) resolve it through this
 * one helper, so the stage, transport and fail-open behavior cannot drift.
 */
import type { NextRequest } from 'next/server';
import type { QuizAnswerVerifier, QuizVerificationQuestion } from '@openmaic/generation';

import { callLLM } from '@/lib/ai/llm';
import { QUIZ_VERIFY_OUTPUT_CAP, clampOutputBudget } from '@/lib/ai/output-budget';
import { getDecisionSiteConfig } from '@/lib/decision/config';
import { decisionConfigFromRequest } from '@/lib/decision/request-config';
import { createDecisionQuizVerifier } from '@/lib/decision/sites/quiz-verifier';
import {
  buildQuizVerifierPrompt,
  parseQuizVerifierResponse,
} from '@/lib/generation/quiz-answer-verifier';
import { getStageModel, parseUserStageRoutes } from '@/lib/server/model-routes';
import { resolveModel } from '@/lib/server/resolve-model';

interface VerifierLogger {
  warn: (message: string, ...args: unknown[]) => void;
}

/**
 * Resolve the LLM verifier for this request. Undefined when no `quiz-verify`
 * route is configured (no extra call) or when the route cannot be resolved
 * (fail-open, with a warning).
 */
async function resolveLlmQuizVerifier(options: {
  req: NextRequest;
  modelString?: string;
  log: VerifierLogger;
}): Promise<QuizAnswerVerifier | undefined> {
  const { req, modelString, log } = options;
  const operatorRoute = getStageModel('quiz-verify');
  const userRoutes = parseUserStageRoutes(req.headers?.get('x-model-routes') ?? null);
  if (!operatorRoute && !userRoutes['quiz-verify']) return undefined;

  const verifier = await resolveModel({
    stage: 'quiz-verify',
    modelString,
    userRoutes,
  }).catch((error: unknown) => {
    log.warn(
      'Quiz verifier route could not be resolved; generating without answer verification:',
      error,
    );
    return null;
  });
  if (!verifier) return undefined;

  return async (questions: readonly QuizVerificationQuestion[]) => {
    const prompt = buildQuizVerifierPrompt(questions);
    const result = await callLLM(
      {
        model: verifier.model,
        system: prompt.system,
        prompt: prompt.user,
        maxOutputTokens: clampOutputBudget(
          QUIZ_VERIFY_OUTPUT_CAP,
          verifier.modelInfo?.outputWindow,
          verifier.thinkingConfig,
        ),
        // The generation loop may re-verify after a correction; one SDK retry
        // covers a transient 429 without making the verifier costly.
        maxRetries: 1,
        abortSignal: req.signal,
      },
      'quiz-verify',
      undefined,
      verifier.thinkingConfig,
      { serverManaged: verifier.serverManaged },
    );
    return parseQuizVerifierResponse(result.text, questions);
  };
}

/**
 * Resolve the verifier for this request.
 *
 * `DECISION_ROUTES['quiz-verify']` takes precedence over the LLM route when
 * configured; the LLM verifier becomes its shadow/triage/replace fallback.
 * With neither configured this returns undefined, exactly as before.
 */
export async function resolveQuizAnswerVerifier(options: {
  req: NextRequest;
  modelString?: string;
  log: VerifierLogger;
}): Promise<QuizAnswerVerifier | undefined> {
  const llmVerifier = await resolveLlmQuizVerifier(options);
  const decisionConfig =
    decisionConfigFromRequest(options.req, 'quiz-verify') ?? getDecisionSiteConfig('quiz-verify');
  if (!decisionConfig) return llmVerifier;

  return createDecisionQuizVerifier({
    config: decisionConfig,
    baseline: llmVerifier,
    signal: options.req.signal,
  });
}
