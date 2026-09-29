/**
 * Exam Free-Response Grading API.
 *
 * POST: grades ONE free-response exam answer against its rubric using the
 * LLM. Extends the `/api/quiz-grade` pattern with per-criterion verdicts so
 * the learner sees exactly which rubric lines their answer met.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import type { RubricCriterion } from '@/lib/types/generation';
import type { ExamFrGrade } from '@/lib/types/exam';

const log = createLogger('Exam Grading');

export const maxDuration = 120;

interface GradeFrRequest {
  questionId?: string;
  prompt: string;
  userAnswer: string;
  rubric: RubricCriterion[];
  sampleAnswer?: string;
  maxPoints: number;
  commentPrompt?: string;
  language?: string;
  /** Whether to return per-rubric-criterion verdicts (default true). */
  withCriteria?: boolean;
}

export async function POST(req: NextRequest) {
  let promptSnippet: string | undefined;
  try {
    const body = (await req.json()) as GradeFrRequest;
    const {
      questionId,
      prompt,
      userAnswer,
      rubric,
      sampleAnswer,
      maxPoints,
      commentPrompt,
      language,
      withCriteria,
    } = body;
    promptSnippet = typeof prompt === 'string' ? prompt.substring(0, 60) : undefined;
    // Per-criterion verdicts are on unless the caller opts out explicitly
    // (the documented default) — the prompt and the parser must agree.
    const includeCriteria = withCriteria !== false;
    if (
      typeof prompt !== 'string' ||
      !prompt ||
      typeof userAnswer !== 'string' ||
      !userAnswer.trim()
    ) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'prompt and userAnswer are required');
    }
    if (!Array.isArray(rubric) || rubric.length === 0) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'rubric is required');
    }
    if (!maxPoints || !Number.isFinite(maxPoints) || maxPoints <= 0) {
      return apiError('INVALID_REQUEST', 400, 'maxPoints must be a positive number');
    }

    const { model: languageModel, thinkingConfig } = await resolveModelFromRequest(
      req,
      body,
      'exam-grading',
    );

    const lines = rubric
      .map(
        (c, i) =>
          `${i + 1}. id=${c.id ?? i} [${c.weight ?? 'important'}] ${c.criterion} — looks for: ${c.lookFor}`,
      )
      .join('\n');

    const system = `You are a fair, rigorous examiner grading a constructed-response answer against an explicit rubric. Grade strictly but generously on partially-satisfied criteria; a criterion fully met earns its weight, half-addressed earns about half, absent earns nothing.

Reply ONLY with JSON:
{
  "score": <integer from 0 to ${maxPoints}>,
  "comment": "<2-4 sentences of feedback: what was strong, what was missing, how to reach the standard>"${includeCriteria ? `,\n  "criteria": [{"id":"<rubric id>","met":<true only when the criterion is fully satisfied, otherwise false>,"comment":"<one sentence>"}]` : ''}
}`;

    const languageNote =
      typeof language === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)
        ? `Write every comment in the language with locale code "${language}".\n\n`
        : '';

    const userPrompt = `${languageNote}RUBRIC:
${lines}
${sampleAnswer ? `\nSTRONG MODEL ANSWER (for calibration only — reward correct reasoning even in different words; do NOT penalize phrasing differences):\n${sampleAnswer}\n` : ''}
GRADING GUIDANCE: ${commentPrompt ?? 'none'}

QUESTION:
${prompt}

STUDENT ANSWER:
${userAnswer}`;

    const result = await callLLM(
      { model: languageModel, system, prompt: userPrompt },
      'exam-grading',
      undefined,
      thinkingConfig,
    );

    const text = result.text.trim();
    let grade: ExamFrGrade;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const criteria =
        includeCriteria && Array.isArray(parsed.criteria)
          ? (parsed.criteria as Array<Record<string, unknown>>)
              .map((c) => ({
                id: String(c.id ?? ''),
                met: c.met === true,
                comment: typeof c.comment === 'string' ? c.comment : '',
              }))
              .filter((c) => c.id)
          : undefined;
      const maybe = (parsed.comment ?? '') as string;
      const rawScore = Number(parsed.score);
      // A missing or non-numeric score is an unparseable grade, not a zero or
      // a NaN that serializes to null and poisons the exam total.
      if (parsed.score === null || parsed.score === undefined || !Number.isFinite(rawScore)) {
        throw new Error('No numeric score');
      }
      grade = {
        questionId: questionId ?? '',
        score: Math.max(0, Math.min(maxPoints, Math.round(rawScore))),
        maxPoints,
        comment: String(maybe),
        criteria: criteria?.length ? criteria : undefined,
      };
    } catch (parseError) {
      // No grade is better than an invented one: a made-up half score would
      // count toward the exam total. The client keeps the learner's answers
      // and lets them submit again.
      log.warn(
        `Exam grade reply could not be parsed [question="${promptSnippet ?? 'unknown'}..."]:`,
        parseError,
      );
      return apiError(
        'GENERATION_FAILED',
        502,
        'Automated grading returned an unreadable result; please submit again',
      );
    }

    return apiSuccess(grade as unknown as Record<string, unknown>);
  } catch (error) {
    log.error(`Exam FR grading failed [question="${promptSnippet ?? 'unknown'}..."]:`, error);
    return llmApiError(error);
  }
}
