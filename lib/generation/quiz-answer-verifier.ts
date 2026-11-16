/**
 * The host side of blind quiz-answer verification.
 *
 * The package owns the blind projection and the key comparison; this module
 * only builds the solver prompt and parses its verdict. Because the input is
 * already stripped of the answer key and analysis, nothing here can leak the
 * key into the verifier prompt.
 */
import { parseJsonResponse, type QuizVerificationAnswer } from '@openmaic/generation';
import type { QuizVerificationQuestion } from '@openmaic/generation';

const SYSTEM_PROMPT = [
  'You are independently solving multiple-choice questions.',
  'The answer key is NOT provided and may contain mistakes.',
  'For each question, decide which option value(s) are actually correct from the question wording and the option labels.',
  '- single: exactly one option value.',
  '- multiple: one or more option values.',
  'Do not assume an option is correct because of its position; judge the content.',
  'Answer every question.',
  'Respond ONLY with JSON: {"answers": [{"id": "q_1", "answers": ["A"]}]}',
].join('\n');

export function buildQuizVerifierPrompt(questions: readonly QuizVerificationQuestion[]): {
  system: string;
  user: string;
} {
  return {
    system: SYSTEM_PROMPT,
    user: JSON.stringify(
      {
        questions: questions.map((question) => ({
          id: question.id,
          type: question.type,
          question: question.question,
          options: question.options,
        })),
      },
      null,
      0,
    ),
  };
}

/**
 * Parse a solver reply. Unknown ids and option values are dropped; a question
 * with no usable verdict is simply absent from the result, which the package
 * treats as "no signal" (never as a disagreement).
 */
export function parseQuizVerifierResponse(
  text: string,
  questions: readonly QuizVerificationQuestion[],
): QuizVerificationAnswer[] {
  let parsed: { answers?: unknown } | null = null;
  try {
    parsed = parseJsonResponse<{ answers?: unknown }>(text);
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.answers)) return [];

  const byId = new Map(questions.map((question) => [question.id, question]));
  const answers: QuizVerificationAnswer[] = [];
  for (const entry of parsed.answers) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, answers: values } = entry as { id?: unknown; answers?: unknown };
    if (typeof id !== 'string') continue;
    const question = byId.get(id);
    if (!question) continue;
    const allowed = new Set(question.options.map((option) => option.value));
    const accepted = Array.isArray(values)
      ? [
          ...new Set(
            values.filter(
              (value): value is string => typeof value === 'string' && allowed.has(value),
            ),
          ),
        ]
      : [];
    if (accepted.length === 0) continue;
    answers.push({ id, answers: accepted });
  }
  return answers;
}
