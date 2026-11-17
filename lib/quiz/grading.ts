import type { QuizQuestion } from '@/lib/types/stage';

export type QuestionResultStatus = 'correct' | 'incorrect' | 'ungraded';

export interface QuestionResult {
  questionId: string;
  correct: boolean | null;
  status: QuestionResultStatus;
  earned: number;
  aiComment?: string;
}

const UNGRADED_COMMENT_EN =
  'Not graded: the grading service could not score this answer. Your other answers still count.';
const UNGRADED_COMMENT_ZH = '本题未评分：评分服务暂时无法给出结果。其他题目的成绩不受影响。';

/**
 * The grader could not produce a usable score. Never invent one: the result
 * is explicitly ungraded, earns no points, and the review UI excludes it from
 * the displayed total instead of counting it as a wrong answer.
 */
export function ungradedResult(questionId: string, language?: string): QuestionResult {
  return {
    questionId,
    correct: null,
    status: 'ungraded',
    earned: 0,
    aiComment: language?.toLowerCase().startsWith('zh') ? UNGRADED_COMMENT_ZH : UNGRADED_COMMENT_EN,
  };
}

export function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Whether a question is graded as open text (AI) rather than by exact
 * answer-key match. Classification is by the explicit `type` only: an
 * unanswered choice question (empty `answer`) is still a choice question and
 * must not be re-routed to AI grading. `hasAnswer` does not override the type.
 */
export function isShortAnswer(q: QuizQuestion): boolean {
  return q.type === 'short_answer';
}

/**
 * Resolve a PERSISTED answer-key entry to an option value. Exact, unique
 * alignment only (per review): an entry that exactly equals one option VALUE
 * resolves to it; one that exactly equals exactly one option LABEL resolves
 * to that option's value. Unknown or ambiguous entries stay unresolved —
 * no case folding, whitespace/Unicode normalization, or wrapper/prefix
 * interpretation is applied.
 *
 * This compatibility resolution exists for the stored key, whose form is
 * whatever the generator wrote. A learner submission is produced by the UI
 * from the option values themselves, so it is compared as-is — see
 * `gradeChoiceQuestions`.
 */
export function resolveAnswerKeyToValue(q: QuizQuestion, answer: string): string {
  const opts = q.options ?? [];
  if (opts.length === 0) return answer;
  const valueMatches = opts.filter((o) => o.value === answer);
  if (valueMatches.length === 1) return valueMatches[0].value;
  const labelMatches = opts.filter((o) => o.label === answer);
  if (labelMatches.length === 1) return labelMatches[0].value;
  return answer;
}

/**
 * Review-UI projection of the same exact resolver used for grading: whether
 * an option's value is among the question's resolved correct-answer values.
 * Receives the question so label-stored keys resolve through the identical
 * exact/unique alignment instead of a separate fuzzy matcher.
 */
export function answerIncludesOption(q: QuizQuestion, optionValue: string): boolean {
  return toArray(q.answer).some((a) => resolveAnswerKeyToValue(q, a) === optionValue);
}

/**
 * Parse a learner's numeric input. Accepts integers, decimals, scientific
 * notation, simple fractions ("3/4"), a trailing unit ("12 cm"), thousands
 * separators ("1,234") and a decimal comma ("1,5"). Returns null when no
 * finite number is present.
 */
export function parseNumericAnswer(raw: string): number | null {
  let text = raw.trim().toLowerCase();
  if (!text) return null;
  const fraction = text.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    if (!Number.isFinite(denominator) || denominator === 0) return null;
    const value = Number(fraction[1]) / denominator;
    return Number.isFinite(value) ? value : null;
  }
  // A comma followed by three digits is a thousands separator, except after a
  // leading zero (0,392 is a decimal comma). Any other comma is a decimal comma.
  if (/^-?\d{1,3}(?:,\d{3})+$/.test(text) && !/^-?0,\d{3}$/.test(text)) {
    text = text.replace(/,/g, '');
  } else if (/^-?\d+,\d+$/.test(text)) {
    text = text.replace(',', '.');
  }
  const match = text.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function gradeNumericAnswer(q: QuizQuestion, raw: string): QuestionResult {
  const points = q.points ?? 1;
  const key = q.answer?.[0];
  const expected = Number(key);
  if (key === undefined || key.trim() === '' || !Number.isFinite(expected)) {
    // A malformed key is a data error, not a learner mistake: do not score it.
    return {
      questionId: q.id,
      correct: null,
      status: 'ungraded',
      earned: 0,
      aiComment: 'This numeric question has no valid answer key, so it was not graded.',
    };
  }
  const submitted = parseNumericAnswer(raw);
  if (submitted === null) {
    return { questionId: q.id, correct: false, status: 'incorrect', earned: 0 };
  }
  const rawTolerance = Number(q.tolerance);
  const tolerance = Number.isFinite(rawTolerance) ? Math.max(0, rawTolerance) : 0;
  const correct = Math.abs(submitted - expected) <= tolerance + 1e-12;
  return {
    questionId: q.id,
    correct,
    status: correct ? 'correct' : 'incorrect',
    earned: correct ? points : 0,
  };
}

/**
 * Grade a `ordering` answer. The options are stored in the correct sequence;
 * the learner submits the same values in their chosen order. Exact sequence
 * equality only — a missing item or a duplicate is wrong, and a question with
 * fewer than two unique items (or duplicate values) is a malformed key, so it
 * is left ungraded rather than scored against the learner.
 */
function gradeOrderingAnswer(q: QuizQuestion, submitted: string[]): QuestionResult {
  const points = q.points ?? 1;
  const key = (q.options ?? []).map((option) => option.value);
  if (key.length < 2 || new Set(key).size !== key.length) {
    return {
      questionId: q.id,
      correct: null,
      status: 'ungraded',
      earned: 0,
      aiComment: 'This ordering question has no valid answer key, so it was not graded.',
    };
  }
  const correct =
    submitted.length === key.length && submitted.every((value, index) => value === key[index]);
  return {
    questionId: q.id,
    correct,
    status: correct ? 'correct' : 'incorrect',
    earned: correct ? points : 0,
  };
}

/**
 * Grade locally checkable questions (single, multiple, numeric, ordering).
 * Short-answer questions are graded by the LLM and are not returned here.
 */
export function gradeChoiceQuestions(
  questions: QuizQuestion[],
  answers: Record<string, string | string[]>,
): QuestionResult[] {
  return questions
    .filter(
      (q) =>
        q.type === 'single' ||
        q.type === 'multiple' ||
        q.type === 'numeric' ||
        q.type === 'ordering',
    )
    .map((q) => {
      if (q.type === 'ordering') {
        return gradeOrderingAnswer(q, toArray(answers[q.id]));
      }
      if (q.type === 'numeric') {
        const raw = answers[q.id];
        return gradeNumericAnswer(q, typeof raw === 'string' ? raw : (raw?.[0] ?? ''));
      }
      const pts = q.points ?? 1;
      // Compatibility resolution applies to the persisted key only. The
      // submission is a value the UI produced from the options, so resolving
      // it too would let a label (or any alias the key accepts) be submitted
      // and accepted as a different option.
      const userAnswer = toArray(answers[q.id]);
      const correctAnswer = toArray(q.answer).map((a) => resolveAnswerKeyToValue(q, a));
      const correct = arraysEqual(userAnswer, correctAnswer);
      return {
        questionId: q.id,
        correct,
        status: correct ? ('correct' as const) : ('incorrect' as const),
        earned: correct ? pts : 0,
      };
    });
}
