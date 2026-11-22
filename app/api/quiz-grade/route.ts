/**
 * Quiz Grading API
 *
 * POST: Receives a text question + user answer, calls LLM for scoring and feedback.
 * Used for short-answer (text) questions that cannot be graded locally.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { QUIZ_GRADE_OUTPUT_CAP, clampOutputBudget } from '@/lib/ai/output-budget';
import { runDecisionSite } from '@/lib/decision/router';
import { decisionConfigFromRequest } from '@/lib/decision/request-config';
import {
  buildQuizDecisionRequest,
  compareQuizGrades,
  quizDecisionInputChars,
  quizGradeFromResult,
  type QuizDecisionInput,
} from '@/lib/decision/sites/quiz-grade';
import { parseJsonResponse } from '@/lib/generation/json-repair';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
const log = createLogger('Quiz Grade');

interface GradeRequest {
  question: string;
  userAnswer: string;
  points: number;
  commentPrompt?: string;
  language?: string;
}

interface GradeResponse {
  score: number;
  comment: string;
}

/**
 * Read a grade from the model's reply. JSON is preferred (and repaired by the
 * shared parser); a prose reply is accepted only when it states an explicit
 * score. Anything else is unreadable — the caller re-prompts once and then
 * reports the question as ungraded instead of inventing a half score.
 */
function parseGrade(text: string, points: number): GradeResponse | null {
  // Only invoke the JSON parser when the reply contains an object; a prose
  // reply is a expected shape here and should not be logged as a parse error.
  const parsed = text.includes('{')
    ? parseJsonResponse<{ score?: unknown; comment?: unknown }>(text)
    : null;
  if (parsed && typeof parsed === 'object') {
    // Number(null) and Number('') are 0: only a present, non-empty value is a
    // score. A missing score is an unreadable grade, not a zero.
    if (parsed.score !== null && parsed.score !== undefined && parsed.score !== '') {
      const raw = Number(parsed.score);
      if (Number.isFinite(raw)) {
        return {
          score: Math.max(0, Math.min(points, Math.round(raw))),
          comment: String(parsed.comment ?? ''),
        };
      }
    }
  }

  const labelled = text.match(
    /\bscore\s*(?:is|of|:|=)\s*(\d+(?:\.\d+)?)\s*(?:(?:\/|of)\s*(\d+(?:\.\d+)?))?/i,
  );
  if (labelled) {
    const raw = Number(labelled[1]);
    const denominator = labelled[2] === undefined ? undefined : Number(labelled[2]);
    // A stated denominator must be this question's maximum; "2 of 3 criteria"
    // is not a score out of 5.
    if (Number.isFinite(raw) && (denominator === undefined || denominator === points)) {
      return {
        score: Math.max(0, Math.min(points, Math.round(raw))),
        comment: text.trim().slice(0, 300),
      };
    }
  }
  return null;
}

/**
 * Input tripwires. Real short answers are a few paragraphs; these bounds stop
 * a pasted document (or a hostile request) from turning one grading call into
 * an unbounded prompt.
 */
const MAX_QUESTION_CHARS = 12_000;
const MAX_ANSWER_CHARS = 24_000;
const MAX_GUIDANCE_CHARS = 8_000;

export async function POST(req: NextRequest) {
  let questionSnippet: string | undefined;
  let resolvedPoints: number | undefined;
  try {
    const body = (await req.json()) as GradeRequest;
    const { question, userAnswer, points, commentPrompt, language } = body;
    questionSnippet = typeof question === 'string' ? question.substring(0, 60) : undefined;
    resolvedPoints = points;

    if (
      typeof question !== 'string' ||
      !question ||
      typeof userAnswer !== 'string' ||
      !userAnswer
    ) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'question and userAnswer are required');
    }

    // Validate points is a positive finite number
    if (!points || !Number.isFinite(points) || points <= 0) {
      return apiError('INVALID_REQUEST', 400, 'points must be a positive number');
    }

    if (question.length > MAX_QUESTION_CHARS) {
      return apiError(
        'INVALID_REQUEST',
        413,
        `question is too large (max ${MAX_QUESTION_CHARS} characters)`,
      );
    }
    if (userAnswer.length > MAX_ANSWER_CHARS) {
      return apiError(
        'INVALID_REQUEST',
        413,
        `userAnswer is too large (max ${MAX_ANSWER_CHARS} characters)`,
      );
    }
    if (
      commentPrompt !== undefined &&
      (typeof commentPrompt !== 'string' || commentPrompt.length > MAX_GUIDANCE_CHARS)
    ) {
      return apiError(
        'INVALID_REQUEST',
        413,
        `commentPrompt is too large (max ${MAX_GUIDANCE_CHARS} characters)`,
      );
    }

    const isZh = language === 'zh-CN';

    const systemPrompt = isZh
      ? `你是一位专业的教育评估专家。请根据题目和学生答案进行评分并给出简短评语。
必须以如下 JSON 格式回复（不要包含其他内容）：
{"score": <0到${points}的整数>, "comment": "<一两句评语>"}`
      : `You are a professional educational assessor. Grade the student's answer and provide brief feedback.
You must reply in the following JSON format only (no other content):
{"score": <integer from 0 to ${points}>, "comment": "<one or two sentences of feedback>"}`;

    const userPrompt = isZh
      ? `题目：${question}
满分：${points}分
${commentPrompt ? `评分要点：${commentPrompt}\n` : ''}学生答案：${userAnswer}`
      : `Question: ${question}
Full marks: ${points} points
${commentPrompt ? `Grading guidance: ${commentPrompt}\n` : ''}Student answer: ${userAnswer}`;

    const gradeWithLlm = async (): Promise<GradeResponse | null> => {
      // Resolve lazily: a site routed to a decision model does not need a chat
      // model, and a decision failure should not fail before the fallback runs.
      const {
        model: languageModel,
        thinkingConfig,
        serverManaged,
      } = await resolveModelFromRequest(req, body, 'quiz-grade');

      const requestGrade = (prompt: string) =>
        callLLM(
          {
            model: languageModel,
            system: systemPrompt,
            prompt,
            // One score + one or two sentences of feedback + any explicit
            // reasoning headroom; the full model window is never useful here.
            maxOutputTokens: clampOutputBudget(QUIZ_GRADE_OUTPUT_CAP, undefined, thinkingConfig),
          },
          'quiz-grade',
          undefined,
          thinkingConfig,
          { serverManaged },
        );

      let grade = parseGrade((await requestGrade(userPrompt)).text, points);

      if (!grade) {
        // One corrective re-prompt is cheaper than a lost question, and a
        // stricter "JSON only" instruction often fixes a prose reply. It is
        // still bounded: after this, the question is ungraded, never invented.
        log.warn(
          `Quiz grade reply could not be parsed [question="${questionSnippet ?? 'unknown'}..."], re-prompting once`,
        );
        const retryInstruction = isZh
          ? `\n\n你上一条回复无法解析。请只回复以下 JSON 对象，不要包含其他内容：{"score": <0 到 ${points} 的整数>, "comment": "<一两句反馈>"}`
          : `\n\nYour previous reply could not be parsed. Reply again with ONLY this JSON object and nothing else: {"score": <integer from 0 to ${points}>, "comment": "<one or two sentences of feedback>"}`;
        grade = parseGrade((await requestGrade(userPrompt + retryInstruction)).text, points);
      }

      return grade;
    };

    const decisionInput: QuizDecisionInput = { question, userAnswer, points, commentPrompt };
    const decisionRequest = buildQuizDecisionRequest(decisionInput);
    const outcome = await runDecisionSite<GradeResponse | null>({
      site: 'quiz-grade',
      inputChars: quizDecisionInputChars(decisionRequest),
      request: decisionRequest,
      baseline: gradeWithLlm,
      fromResult: (result, config) => quizGradeFromResult(result, decisionInput, config),
      compare: (decision, baseline) =>
        decision && baseline ? compareQuizGrades(decision, baseline) : undefined,
    }, { config: await decisionConfigFromRequest(req, 'quiz-grade') });

    const grade = outcome.source === 'none' ? null : outcome.value;

    if (!grade) {
      log.error(
        `Quiz grade reply was unreadable after the retry [question="${questionSnippet ?? 'unknown'}..."]`,
      );
      return apiError(
        'GENERATION_FAILED',
        502,
        'Automated grading returned an unreadable result; please try again',
      );
    }

    return apiSuccess({ ...grade });
  } catch (error) {
    log.error(
      `Quiz grading failed [question="${questionSnippet ?? 'unknown'}...", points=${resolvedPoints ?? 'unknown'}]:`,
      error,
    );
    return llmApiError(error, 'Failed to grade answer');
  }
}
