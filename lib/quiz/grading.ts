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
 * A question's point value, guarded the way activity checks are.
 *
 * Authoring input and imported documents are untrusted: a negative or
 * non-finite value must not turn a correct answer into a deduction, and a
 * zero-point question must stay worth zero rather than silently becoming one.
 */
export function quizQuestionPoints(points: unknown): number {
  return typeof points === 'number' && Number.isFinite(points) && points >= 0 ? points : 1;
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
 *
 * A numeric field is free text, so the parser cannot assume the number is the
 * whole string: "1,234 cm" and "1,234.5" are the same value with a unit or a
 * fraction attached, and reading only the digits before the first separator
 * would turn them into 1. The separator normalization below therefore runs on
 * the numeric token itself and understands mixed conventions:
 *
 * - both separators present: the later one is the decimal mark, the earlier
 *   one groups thousands ("1,234.5" and "1.234,5" both mean 1234.5);
 * - one comma: a three-digit tail after one to three leading digits is
 *   grouping, except after a leading zero ("0,392" is a decimal comma);
 * - repeated separators: valid only when every group after the first has
 *   three digits, so "1,23,456" is rejected instead of silently becoming 1.
 */
export function parseNumericAnswer(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  // A number with separators and an optional exponent. The trailing `\d`
  // keeps sentence punctuation out ("chapter 1, section 2" yields 1, not "1,").
  const numberToken = '-?\\d(?:[\\d.,]*\\d)?(?:e[+-]?\\d+)?';
  const fraction = text.match(new RegExp(`^(${numberToken})\\s*\\/\\s*(${numberToken})`));
  if (fraction) {
    const numerator = parseNumericToken(fraction[1]!);
    const denominator = parseNumericToken(fraction[2]!);
    if (numerator === null || denominator === null || denominator === 0) return null;
    const value = numerator / denominator;
    return Number.isFinite(value) ? value : null;
  }

  const match = text.match(new RegExp(numberToken));
  if (!match) return null;
  return parseNumericToken(match[0]);
}

/**
 * Parse one numeric token, honoring thousands grouping and decimal commas.
 *
 * The sign and exponent are stripped first so they cannot be mistaken for
 * separators; the mantissa is then normalized to plain `digits.digits`, and
 * anything that does not describe one unambiguous number is rejected.
 */
function parseNumericToken(token: string): number | null {
  const exponentMatch = token.match(/e[+-]?\d+$/);
  const exponent = exponentMatch ? exponentMatch[0] : '';
  const mantissa = exponent ? token.slice(0, -exponent.length) : token;
  const negative = mantissa.startsWith('-');
  const body = negative ? mantissa.slice(1) : mantissa;
  if (!body) return null;

  const normalized = normalizeNumericSeparators(body);
  if (normalized === null) return null;

  const value = Number(`${negative ? '-' : ''}${normalized}${exponent}`);
  return Number.isFinite(value) ? value : null;
}

/** Rewrite a mantissa's grouping/decimal separators to `digits.digits`. */
function normalizeNumericSeparators(body: string): string | null {
  const lastDot = body.lastIndexOf('.');
  const lastComma = body.lastIndexOf(',');
  if (lastDot < 0 && lastComma < 0) return /^\d+$/.test(body) ? body : null;

  if (lastDot >= 0 && lastComma >= 0) {
    // The separator that comes last is the decimal mark; the other groups.
    const decimal = lastDot > lastComma ? '.' : ',';
    const grouping = decimal === '.' ? ',' : '.';
    return normalizeGroupedDecimal(body, decimal, grouping);
  }

  if (lastComma >= 0) {
    const commaParts = body.split(',');
    if (commaParts.length === 2) {
      const [integerPart, fractionPart] = commaParts as [string, string];
      const grouping = integerPart.length <= 3 && fractionPart.length === 3 && integerPart !== '0';
      if (grouping) {
        return /^\d+$/.test(integerPart) && /^\d+$/.test(fractionPart)
          ? `${integerPart}${fractionPart}`
          : null;
      }
      return /^\d+$/.test(integerPart) && /^\d+$/.test(fractionPart)
        ? `${integerPart}.${fractionPart}`
        : null;
    }
    return normalizeGroupedInteger(body, ',');
  }

  const dotParts = body.split('.');
  if (dotParts.length === 2) {
    return /^\d+$/.test(dotParts[0]!) && /^\d+$/.test(dotParts[1]!)
      ? `${dotParts[0]}.${dotParts[1]}`
      : null;
  }
  // Repeated dots are European grouping ("1.234.567"); only accept whole
  // three-digit groups so a malformed number is rejected rather than truncated.
  return normalizeGroupedInteger(body, '.');
}

function normalizeGroupedDecimal(
  body: string,
  decimal: '.' | ',',
  grouping: '.' | ',',
): string | null {
  const decimalIndex = body.lastIndexOf(decimal);
  if (body.indexOf(decimal) !== decimalIndex) return null;
  const integerPart = body.slice(0, decimalIndex);
  const fractionPart = body.slice(decimalIndex + 1);
  if (!/^\d+$/.test(fractionPart)) return null;
  const grouped = normalizeGroupedInteger(integerPart, grouping);
  return grouped === null ? null : `${grouped}.${fractionPart}`;
}

function normalizeGroupedInteger(text: string, grouping: '.' | ','): string | null {
  const groups = text.split(grouping);
  if (groups.length < 2) return null;
  if (!/^\d{1,3}$/.test(groups[0]!)) return null;
  if (!groups.slice(1).every((group) => /^\d{3}$/.test(group))) return null;
  return groups.join('');
}

/**
 * Parse a numeric answer key. The whole key must be one unambiguous number:
 * grouping and decimal commas are accepted (the learner parser's job is to
 * read what a learner types, but the key is data, and prose like "3 to 5"
 * must stay ungraded rather than silently become 3). A trailing unit belongs
 * in the question's `unit` field, not in the key.
 */
function parseNumericKey(key: string | undefined): number | null {
  if (key === undefined) return null;
  const text = key.trim().toLowerCase();
  if (!/^[+-]?\d(?:[\d.,]*\d)?(?:e[+-]?\d+)?$/.test(text)) return null;
  return parseNumericToken(text.startsWith('+') ? text.slice(1) : text);
}

function gradeNumericAnswer(q: QuizQuestion, raw: string): QuestionResult {
  const points = quizQuestionPoints(q.points);
  const expected = parseNumericKey(q.answer?.[0]);
  if (expected === null) {
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
  const points = quizQuestionPoints(q.points);
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

/** Every value present and distinct: the shape an unambiguous pairing needs. */
function allDistinct(values: readonly string[], requireNonEmpty: boolean): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    if (requireNonEmpty && value.length === 0) return false;
    if (seen.has(value)) return false;
    seen.add(value);
  }
  return true;
}

/**
 * Grade a `matching` answer. `options` and `matches` are aligned, so the
 * correct partner of options[i] is matches[i]; the learner submits the chosen
 * right value per left item, in the same order. All pairs must be correct.
 * A key with unequal columns, repeated values, or repeated right labels is
 * ambiguous and stays ungraded.
 */
function gradeMatchingAnswer(q: QuizQuestion, submitted: string[]): QuestionResult {
  const points = quizQuestionPoints(q.points);
  const left = q.options ?? [];
  const right = q.matches ?? [];
  const keyValid =
    left.length >= 2 &&
    left.length === right.length &&
    allDistinct(
      left.map((item) => item.value),
      true,
    ) &&
    allDistinct(
      right.map((item) => item.value),
      true,
    ) &&
    allDistinct(
      right.map((item) => item.label.trim()),
      true,
    );
  if (!keyValid) {
    return {
      questionId: q.id,
      correct: null,
      status: 'ungraded',
      earned: 0,
      aiComment: 'This matching question has no valid answer key, so it was not graded.',
    };
  }
  const correct =
    submitted.length === left.length &&
    submitted.every((value, index) => value === right[index]?.value);
  return {
    questionId: q.id,
    correct,
    status: correct ? 'correct' : 'incorrect',
    earned: correct ? points : 0,
  };
}

/**
 * Grade locally checkable questions (single, multiple, numeric, ordering,
 * matching). Short-answer questions are graded by the LLM and are not returned
 * here.
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
        q.type === 'ordering' ||
        q.type === 'matching',
    )
    .map((q) => {
      if (q.type === 'matching') {
        return gradeMatchingAnswer(q, toArray(answers[q.id]));
      }
      if (q.type === 'ordering') {
        return gradeOrderingAnswer(q, toArray(answers[q.id]));
      }
      if (q.type === 'numeric') {
        const raw = answers[q.id];
        return gradeNumericAnswer(q, typeof raw === 'string' ? raw : (raw?.[0] ?? ''));
      }
      const pts = quizQuestionPoints(q.points);
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
