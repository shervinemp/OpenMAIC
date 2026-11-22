/**
 * Per-request binding for the blind quiz-answer verifier.
 *
 * The `quiz-verify` stage is opt-in via the single System 1 choice in Settings.
 * Both the scene-content route (scene quizzes) and the exam route (MC keys)
 * resolve it through this one helper, so the stage, transport and fail-open
 * behavior cannot drift.
 */
import type { NextRequest } from 'next/server';
import type { QuizAnswerVerifier, QuizVerificationQuestion } from '@openmaic/generation';

import { callLLM } from '@/lib/ai/llm';
import { QUIZ_VERIFY_OUTPUT_CAP, clampOutputBudget } from '@/lib/ai/output-budget';
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
 * Resolve the LLM baseline verifier for this request. Undefined when no
 * `quiz-verify` route is configured and no System 1 choice was sent — in that
 * case there is no verifier, not an implicit LLM one. Also undefined (with a
 * warning) when a configured route cannot be resolved. The per-request System
 * 1 choice from Settings is the other opt-in path and is layered on by the
 * caller.
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
 * The Settings-driven `x-decision-*` headers supply the one decision choice;
 * the LLM verifier is its fallback. With no opt-in at all this returns no
 * verifier; the caller layers on the Settings-driven System 1 choice.
 */
export async function resolveQuizAnswerVerifier(options: {
  req: NextRequest;
  modelString?: string;
  log: VerifierLogger;
}): Promise<QuizAnswerVerifier | undefined> {
  const llmVerifier = await resolveLlmQuizVerifier(options);
  const decisionConfig = await decisionConfigFromRequest(options.req, 'quiz-verify');
  if (!decisionConfig) return llmVerifier;

  return createDecisionQuizVerifier({
    config: decisionConfig,
    baseline: llmVerifier,
    signal: options.req.signal,
  });
}
