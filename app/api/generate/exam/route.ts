/**
 * Exam Generation API (semester midterm / final).
 *
 * POST: builds a full exam spec — a substantial MC section (scenario /
 * application single-answer questions with explanations) plus constructed
 * free-response questions graded per rubric — from the course blueprint and
 * the covered unit outlines. Answers are graded by `POST /api/exam/grade-fr`.
 *
 * The exam plans from the OUTLINE layer, so it is generable the moment the
 * blueprint exists, without waiting for all scene content.
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { parseJsonResponse } from '@/lib/generation/json-repair';
import type { CourseBlueprint, SceneOutline } from '@/lib/types/generation';
import type { ExamChoiceQuestion, ExamFreeResponse, ExamKind, ExamSpec } from '@/lib/types/exam';

const log = createLogger('Exam Generation');

export const maxDuration = 300;

/** Minimum quality contract: MC must be substantial, not a token quiz. */
export const MIN_MC_QUESTIONS = 12;
export const MIN_FR_QUESTIONS = 3;

function coerceChoiceQuestion(raw: unknown, index: number): ExamChoiceQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const options = Array.isArray(r.options) ? r.options : [];
  const coercedOptions = options
    .map((o) => {
      if (!o || typeof o !== 'object') return null;
      const opt = o as Record<string, unknown>;
      const label = typeof opt.label === 'string' ? opt.label.trim() : '';
      if (!label) return null;
      return { label, value: String(opt.value ?? String.fromCharCode(65 + index)).slice(0, 1) };
    })
    .filter(Boolean) as Array<{ label: string; value: string }>;
  if (coercedOptions.length < 2) return null;
  const answerValues = (Array.isArray(r.answer) ? r.answer : [r.answer])
    .map((v) => String(v).trim().slice(0, 1).toUpperCase())
    .filter(Boolean);
  if (answerValues.length !== 1) return null;
  const question = typeof r.question === 'string' ? r.question.trim() : '';
  const analysis = typeof r.analysis === 'string' ? r.analysis.trim() : '';
  return {
    id: `mc_${index + 1}`,
    question,
    options: coercedOptions,
    answer: answerValues,
    analysis,
    points: 1,
  };
}

function coerceFreeResponse(raw: unknown, index: number): ExamFreeResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : '';
  const sampleAnswer = typeof r.sampleAnswer === 'string' ? r.sampleAnswer.trim() : '';
  const rubricRaw = Array.isArray(r.rubric) ? r.rubric : [];
  const rubric = rubricRaw
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const rc = c as Record<string, unknown>;
      const criterion = typeof rc.criterion === 'string' ? rc.criterion.trim() : '';
      const lookFor = typeof rc.lookFor === 'string' ? rc.lookFor.trim() : '';
      if (!criterion || !lookFor) return null;
      const weight = rc.weight === 'essential' || rc.weight === 'important' ? rc.weight : 'important';
      return {
        id: typeof rc.id === 'string' && rc.id.trim() ? rc.id.trim() : `rubric_${index + 1}_n`,
        criterion,
        weight,
        lookFor,
      };
    })
    .filter(Boolean) as ExamFreeResponse['rubric'];
  if (!prompt || rubric.length < 2) return null;
  const guidance = Array.isArray(r.guidance)
    ? r.guidance.filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
    : [];
  const maxPoints =
    typeof r.maxPoints === 'number' && Number.isFinite(r.maxPoints) && r.maxPoints > 0
      ? Math.min(20, Math.max(4, Math.round(r.maxPoints)))
      : 10;
  return {
    id: `fr_${index + 1}`,
    prompt,
    guidance: guidance.length ? guidance : undefined,
    rubric,
    sampleAnswer,
    maxPoints,
    commentPrompt: typeof r.commentPrompt === 'string' ? r.commentPrompt : undefined,
  };
}

export function findShortfalls(spec: ExamSpec): string[] {
  const findings: string[] = [];
  if (spec.mcQuestions.length < MIN_MC_QUESTIONS) {
    findings.push(`MC section has ${spec.mcQuestions.length} questions; requires at least ${MIN_MC_QUESTIONS}`);
  }
  if (spec.frQuestions.length < MIN_FR_QUESTIONS) {
    findings.push(`free-response section has ${spec.frQuestions.length} questions; requires at least ${MIN_FR_QUESTIONS}`);
  }
  return findings;
}

export async function POST(req: NextRequest) {
  let kind: ExamKind | undefined;
  try {
    const body = (await req.json()) as {
      kind: ExamKind;
      blueprint: CourseBlueprint;
      coveredOutlines: SceneOutline[];
      languageDirective?: string;
    };
    kind = body.kind;
    const { blueprint, coveredOutlines, languageDirective } = body;
    if ((kind !== 'midterm' && kind !== 'final') || !blueprint) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'kind (midterm|final) and blueprint are required');
    }
    const examKind: ExamKind = kind;

    const { model: languageModel, modelInfo, thinkingConfig } = await resolveModelFromRequest(
      req,
      body,
      'exam-generation',
    );

    const digest = coveredOutlines
      .slice(0, 400)
      .map(
        (o) =>
          `- [${o.type}] ${o.title}\n  objective: ${o.description ?? ''}\n  key points: ${(o.keyPoints ?? [])
            .slice(0, 4)
            .join('; ')}`,
      )
      .join('\n');

    const system = `You are a rigorous university examiner writing a ${kind === 'midterm' ? 'MIDTERM' : 'FINAL'} exam for an instructor-grade course. Exams must discriminate real understanding: application, justification, and synthesis under constraints.

Output ONLY JSON:
{
  "mcQuestions": [
    { "question": "<scenario/application stem: a situation the learner must reason about, NOT a bare definition>", "options": [{"label":"<answer option one>","value":"A"}, {"label":"...","value":"B"}, {"label":"...","value":"C"}, {"label":"...","value":"D"}], "answer": ["<value of the correct option>"], "analysis": "<why the correct option is right and the best distractor is wrong>" }
    // at least ${MIN_MC_QUESTIONS} questions, exactly 4-5 options each, exactly one correct answer, distractors must be plausible common misconceptions
  ],
  "frQuestions": [
    { "prompt": "<a constructed-response task: design, justify, analyze a case, or critique a claim>", "guidance": ["<2-4 framing pointers that do not give the answer away>"], "rubric": [{"id":"r1","criterion":"<what a strong answer does>","weight":"essential","lookFor":"<the concrete indicator a grader looks for>"}, ...], "sampleAnswer": "<a strong model answer>", "maxPoints": 10, "commentPrompt": "<1-2 sentences of grading guidance beyond the rubric>" }
    // ${MIN_FR_QUESTIONS} questions; every question needs 3-5 rubric criteria, at least one 'essential'
  ]
}
Rules:
- Ground every question in the covered material below; no trivia-only recall.
- MC questions must carry real diagnosis: each distractor must encode a specific misconception.
- The FR tasks must be answerable by a serious student with roughly 8-14 sentences each; do not require data or tools not provided.
- Course title: "${blueprint.title ?? 'the course'}". Audience: "${blueprint.audience ?? 'intermediate learners'}".
${languageDirective ? `- Language directive: ${languageDirective}` : '- Write all exam content in the course language.'}`;

    const userPrompt = `COVERED MATERIAL (outline titles, objectives, key points):\n${digest}\n\nWrite the exam now. Remember: at least ${MIN_MC_QUESTIONS} MC questions and ${MIN_FR_QUESTIONS} free-response questions, and conform to the JSON schema exactly.`;

    const calllOnce = async (extra?: string) => {
      const result = await callLLM(
        {
          model: languageModel,
          system,
          prompt: extra ? `${userPrompt}\n\nCONSTRAINT VIOLATION REPORT — fix and resubmit the FULL JSON:\n${extra}` : userPrompt,
          maxOutputTokens: modelInfo?.outputWindow,
          maxRetries: 0,
        },
        'exam-generation',
        undefined,
        thinkingConfig,
      );
      return result.text;
    };

    const buildSpec = (text: string): ExamSpec | null => {
      const parsed = parseJsonResponse<Record<string, unknown>>(text);
      if (!parsed) return null;
      const mcRaw = Array.isArray(parsed.mcQuestions) ? parsed.mcQuestions : [];
      const frRaw = Array.isArray(parsed.frQuestions) ? parsed.frQuestions : [];
      const mcQuestions = mcRaw
        .map((q: unknown, i: number) => coerceChoiceQuestion(q, i))
        .filter(Boolean) as ExamChoiceQuestion[];
      const frQuestions = frRaw
        .map((q: unknown, i: number) => coerceFreeResponse(q, i))
        .filter(Boolean) as ExamFreeResponse[];
      const blueprintUnits = blueprint.units?.length ?? 0;
      const from = 0;
      const to =
        examKind === 'midterm' ? Math.max(0, Math.ceil(blueprintUnits / 2) - 1) : Math.max(0, blueprintUnits - 1);
      return {
        kind: examKind,
        title:
          typeof parsed.title === 'string' && parsed.title.trim()
            ? parsed.title.trim()
            : `${examKind === 'midterm' ? 'Midterm' : 'Final'} Exam`,
        coverage: blueprintUnits
          ? `Units ${from + 1}${to > from ? `-${to + 1}` : ''}`
          : 'Whole course',
        unitRange: { from, to },
        mcQuestions,
        frQuestions,
        generatedAt: Date.now(),
      };
    };

    let spec = buildSpec(await calllOnce());
    if (!spec) {
      return apiError('GENERATION_FAILED', 500, 'Exam generation returned unparseable output');
    }
    const findings = findShortfalls(spec);
    if (findings.length) {
      log.warn(`Exam spec shortfall (${findings.join('; ')}); re-prompting once`);
      spec = buildSpec(await calllOnce(findings.join(';\n')));
      if (!spec) {
        return apiError('GENERATION_FAILED', 500, 'Exam generation returned unparseable output on retry');
      }
      const retryFindings = findShortfalls(spec);
      if (retryFindings.length) {
        return apiError('GENERATION_FAILED', 502, `Exam spec incomplete: ${retryFindings.join('; ')}`);
      }
    }

    return apiSuccess({ exam: spec });
  } catch (error) {
    log.error(`Exam generation failed [kind=${kind ?? 'unknown'}]:`, error);
    return llmApiError(error);
  }
}
