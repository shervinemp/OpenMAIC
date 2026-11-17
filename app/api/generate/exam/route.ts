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
import { EXAM_GENERATION_OUTPUT_CAP, clampOutputBudget } from '@/lib/ai/output-budget';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { resolveQuizAnswerVerifier } from '@/lib/server/quiz-verifier';
import { blindQuizQuestions, quizAnswerDisagreements } from '@openmaic/generation';
import {
  normalizeConceptTags,
  normalizeOptionNote,
  type QuizOption,
  type QuizQuestion,
} from '@openmaic/dsl';
import { parseJsonResponse } from '@/lib/generation/json-repair';
import type { CourseBlueprint, SceneOutline } from '@/lib/types/generation';
import type { ExamChoiceQuestion, ExamFreeResponse, ExamKind, ExamSpec } from '@/lib/types/exam';
import { DEFAULT_EXAM_FORMS } from '@/lib/exam/variants';
import { DEFAULT_EXAM_TIMING } from '@/lib/exam/timing';

const log = createLogger('Exam Generation');

export const maxDuration = 300;

/**
 * Minimum quality contract: the generated artifact is a POOL, not one paper.
 * Each attempt draws a seeded subset (12/3 midterm, 14/4 final), so the pool
 * must be materially larger than a single form. Deduplicated stems count.
 */
export const MIN_MC_QUESTIONS = 18;
export const MIN_FR_QUESTIONS = 5;

/** Exported for the route's unit tests; not part of the public API. */
export function coerceChoiceQuestion(raw: unknown, index: number): ExamChoiceQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const options = Array.isArray(r.options) ? r.options : [];
  const coercedOptions: QuizOption[] = [];
  options.forEach((o, optionIndex) => {
    if (!o || typeof o !== 'object') return;
    const opt = o as Record<string, unknown>;
    const label = typeof opt.label === 'string' ? opt.label.trim() : '';
    if (!label) return;
    // A missing value falls back to the option's own letter; keyed by the
    // question index it gave every option of the question the same value.
    const value = String(opt.value ?? String.fromCharCode(65 + optionIndex))
      .trim()
      .slice(0, 1)
      .toUpperCase();
    if (!value) return;
    const rationale = normalizeOptionNote(opt.rationale);
    const misconception = normalizeOptionNote(opt.misconception);
    coercedOptions.push({
      label,
      value,
      ...(rationale ? { rationale } : {}),
      ...(misconception ? { misconception } : {}),
    });
  });
  if (coercedOptions.length < 2) return null;
  // Two options sharing a value make the key ambiguous.
  if (new Set(coercedOptions.map((o) => o.value)).size !== coercedOptions.length) return null;
  const answerValues = (Array.isArray(r.answer) ? r.answer : [r.answer])
    .map((v) => String(v).trim().slice(0, 1).toUpperCase())
    .filter(Boolean);
  if (answerValues.length !== 1) return null;
  // A key that names no option can never be answered correctly.
  if (!coercedOptions.some((o) => o.value === answerValues[0])) return null;
  const question = typeof r.question === 'string' ? r.question.trim() : '';
  if (!question) return null;
  const analysis = typeof r.analysis === 'string' ? r.analysis.trim() : '';
  // A misconception describes a wrong option; drop a stray one on the key.
  const optionsForSpec = coercedOptions.map((option) =>
    answerValues.includes(option.value) && option.misconception
      ? {
          label: option.label,
          value: option.value,
          ...(option.rationale ? { rationale: option.rationale } : {}),
        }
      : option,
  );
  return {
    id: `mc_${index + 1}`,
    question,
    options: optionsForSpec,
    answer: answerValues,
    analysis,
    points: 1,
    concepts: normalizeConceptTags(r.concepts),
  };
}

/** Exported for the route's unit tests; not part of the public API. */
export function coerceFreeResponse(raw: unknown, index: number): ExamFreeResponse | null {
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
      const weight =
        rc.weight === 'essential' || rc.weight === 'important' ? rc.weight : 'important';
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
    concepts: normalizeConceptTags(r.concepts),
  };
}

/** Drop repeated stems so a pool cannot inflate its count by restating one item. */
function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const normalized = key(item).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(item);
  }
  return result;
}

export function findShortfalls(spec: ExamSpec): string[] {
  const findings: string[] = [];
  if (spec.mcQuestions.length < MIN_MC_QUESTIONS) {
    findings.push(
      `MC section has ${spec.mcQuestions.length} questions; requires at least ${MIN_MC_QUESTIONS}`,
    );
  }
  if (spec.frQuestions.length < MIN_FR_QUESTIONS) {
    findings.push(
      `free-response section has ${spec.frQuestions.length} questions; requires at least ${MIN_FR_QUESTIONS}`,
    );
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
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'kind (midterm|final) and blueprint are required',
      );
    }
    const examKind: ExamKind = kind;

    const {
      model: languageModel,
      modelInfo,
      modelString,
      thinkingConfig,
    } = await resolveModelFromRequest(req, body, 'exam-generation');

    const digest = (Array.isArray(coveredOutlines) ? coveredOutlines : [])
      .slice(0, 400)
      .map(
        (o) =>
          `- [${o.type}] ${o.title}\n  objective: ${o.description ?? ''}\n  key points: ${(
            o.keyPoints ?? []
          )
            .slice(0, 4)
            .join('; ')}`,
      )
      .join('\n');

    const form = DEFAULT_EXAM_FORMS[examKind];
    const system = `You are a rigorous university examiner writing a ${kind === 'midterm' ? 'MIDTERM' : 'FINAL'} exam for an instructor-grade course. Exams must discriminate real understanding: application, justification, and synthesis under constraints.

Write a QUESTION POOL, not a single paper: the course platform draws a different seeded form from the pool for every learner and retake. Every question must stand alone, and no two questions may test the same point in the same way.

Output ONLY JSON:
{
  "mcQuestions": [
    { "question": "<scenario/application stem: a situation the learner must reason about, NOT a bare definition>", "concepts": ["<1-3 short lowercase concept tags>"], "options": [{"label":"<answer option one>","value":"A","rationale":"<why this option is right or wrong>"}, {"label":"<plausible distractor>","value":"B","rationale":"<why it is wrong>","misconception":"<the specific wrong idea it encodes>"}, {"label":"...","value":"C"}, {"label":"...","value":"D"}], "answer": ["<value of the correct option>"], "analysis": "<why the correct option is right and the best distractor is wrong>" }
    // at least ${MIN_MC_QUESTIONS} distinct questions, exactly 4-5 options each, exactly one correct answer, distractors must be plausible common misconceptions
  ],
  "frQuestions": [
    { "prompt": "<a constructed-response task: design, justify, analyze a case, or critique a claim>", "concepts": ["<1-3 short lowercase concept tags>"], "guidance": ["<2-4 framing pointers that do not give the answer away>"], "rubric": [{"id":"r1","criterion":"<what a strong answer does>","weight":"essential","lookFor":"<the concrete indicator a grader looks for>"}, ...], "sampleAnswer": "<a strong model answer>", "maxPoints": 10, "commentPrompt": "<1-2 sentences of grading guidance beyond the rubric>" }
    // at least ${MIN_FR_QUESTIONS} distinct questions; every question needs 3-5 rubric criteria, at least one 'essential'
  ]
}
The ${kind === 'midterm' ? 'midterm' : 'final'} form draws ${form.mcCount} MC questions and ${form.frCount} written questions from this pool.
Rules:
- Ground every question in the covered material below; no trivia-only recall.
- Every question must carry "concepts": 1-3 short lowercase tags naming the ideas it measures, reused for the same idea across the pool. Never tag the question format.
- MC questions must carry real diagnosis: each distractor must encode a specific misconception, and every option should include "rationale" plus "misconception" on wrong options.
- The FR tasks must be answerable by a serious student with roughly 8-14 sentences each; do not require data or tools not provided.
- Do not repeat a stem, scenario, or task; a duplicate wastes pool space and will be rejected.
- Course title: "${blueprint.title ?? 'the course'}". Audience: "${blueprint.audience ?? 'intermediate learners'}".
${languageDirective ? `- Language directive: ${languageDirective}` : '- Write all exam content in the course language.'}`;

    const userPrompt = `COVERED MATERIAL (outline titles, objectives, key points):\n${digest}\n\nWrite the pool now. Remember: at least ${MIN_MC_QUESTIONS} distinct MC questions and ${MIN_FR_QUESTIONS} distinct free-response questions, and conform to the JSON schema exactly.`;

    const callOnce = async (extra?: string) => {
      const result = await callLLM(
        {
          model: languageModel,
          system,
          prompt: extra
            ? `${userPrompt}\n\nCONSTRAINT VIOLATION REPORT — fix and resubmit the FULL JSON:\n${extra}`
            : userPrompt,
          maxOutputTokens: clampOutputBudget(
            EXAM_GENERATION_OUTPUT_CAP,
            modelInfo?.outputWindow,
            thinkingConfig,
          ),
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
      const mcQuestions = dedupeBy(
        mcRaw
          .map((q: unknown, i: number) => coerceChoiceQuestion(q, i))
          .filter(Boolean) as ExamChoiceQuestion[],
        (question) => question.question,
      );
      const frQuestions = dedupeBy(
        frRaw
          .map((q: unknown, i: number) => coerceFreeResponse(q, i))
          .filter(Boolean) as ExamFreeResponse[],
        (question) => question.prompt,
      );
      const blueprintUnits = blueprint.units?.length ?? 0;
      const from = 0;
      const to =
        examKind === 'midterm'
          ? Math.max(0, Math.ceil(blueprintUnits / 2) - 1)
          : Math.max(0, blueprintUnits - 1);
      const timing = DEFAULT_EXAM_TIMING[examKind];
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
        formConfig: { ...DEFAULT_EXAM_FORMS[examKind] },
        timing: { ...timing },
        generatedAt: Date.now(),
      };
    };

    let spec = buildSpec(await callOnce());
    if (!spec) {
      return apiError('GENERATION_FAILED', 500, 'Exam generation returned unparseable output');
    }

    /**
     * Blind MC verification is OPT-IN through the same `quiz-verify` route as
     * scene quizzes. A wrong exam key is high-stakes, so a disagreement buys
     * one corrective re-prompt; on the retry the generated key is kept (a
     * cheap blind solve never rejects an otherwise valid exam).
     */
    const verifier = await resolveQuizAnswerVerifier({ req, modelString, log });
    const verifyChoiceKeys = async (exam: ExamSpec): Promise<string[]> => {
      if (!verifier) return [];
      const questions: QuizQuestion[] = exam.mcQuestions.map((question) => ({
        id: question.id,
        type: 'single',
        question: question.question,
        options: question.options,
        answer: question.answer,
        hasAnswer: true,
      }));
      const blind = blindQuizQuestions(questions);
      if (blind.length === 0) return [];
      try {
        const answers = await verifier(blind);
        return quizAnswerDisagreements(questions, answers).map(
          (finding) =>
            `MC question ${finding.questionId} may have the wrong key: key says ${finding.marked.join(
              ', ',
            )}, blind solve chose ${finding.solved.join(', ')}. Re-check the question and fix the key.`,
        );
      } catch (error) {
        log.warn('Exam MC answer verification failed; keeping the generated keys:', error);
        return [];
      }
    };

    const findings = findShortfalls(spec);
    // No point blind-solving a structurally incomplete section: the retry
    // rebuilds it and is verified afterwards.
    const answerFindings = findings.length === 0 ? await verifyChoiceKeys(spec) : [];
    if (findings.length || answerFindings.length) {
      const feedback = [...findings, ...answerFindings].join(';\n');
      log.warn(`Exam spec issues (${feedback}); re-prompting once`);
      spec = buildSpec(await callOnce(feedback));
      if (!spec) {
        return apiError(
          'GENERATION_FAILED',
          500,
          'Exam generation returned unparseable output on retry',
        );
      }
      const retryFindings = findShortfalls(spec);
      if (retryFindings.length) {
        return apiError(
          'GENERATION_FAILED',
          502,
          `Exam spec incomplete: ${retryFindings.join('; ')}`,
        );
      }
      const retryAnswerFindings = await verifyChoiceKeys(spec);
      if (retryAnswerFindings.length) {
        log.error(
          `Exam MC answer verification still disagreed after the retry; keeping the generated keys: ${retryAnswerFindings.join('; ')}`,
        );
      }
    }

    return apiSuccess({ exam: spec });
  } catch (error) {
    log.error(`Exam generation failed [kind=${kind ?? 'unknown'}]:`, error);
    return llmApiError(error);
  }
}
