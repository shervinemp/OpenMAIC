import type { QuizQuestion } from '@/lib/types/stage';

/**
 * Stored answer keys, rewritten to option values where the intent is certain.
 *
 * Grading resolves a key by exact value or exact, unique label and nothing
 * else (`resolveAnswerKeyToValue`, by design: no fuzzy matching at grade
 * time). Generators before the option contract wrote other shapes, and two of
 * them grade a correct choice as wrong:
 *
 *  - a truncated label ("Completeness" for "Completeness, because the values
 *    are absent") — resolved when it is a whole-word prefix of exactly one
 *    option;
 *  - a multi-select key written as ONE string joining the correct labels
 *    ("<label A>; <label C>") — resolved when the labels it contains account
 *    for all of it, separators aside.
 *
 * Label-valued keys that already resolve are rewritten to their values too,
 * so every consumer (review UI, exams, agent tools) reads one canonical form.
 * A question is only rewritten when EVERY key resolves; anything uncertain is
 * left exactly as stored. Returns the new answer, or null for no change.
 */
export function healedAnswerKey(question: QuizQuestion): string[] | null {
  if (question.type === 'short_answer') return null;
  const options = question.options ?? [];
  const keys = Array.isArray(question.answer) ? question.answer : [];
  if (options.length === 0 || keys.length === 0) return null;

  const resolved: string[] = [];
  for (const key of keys) {
    const values = resolveKey(question.type, options, key);
    if (!values) return null;
    for (const value of values) if (!resolved.includes(value)) resolved.push(value);
  }
  const canonical = options.map((option) => option.value).filter((v) => resolved.includes(v));
  if (question.type === 'single' && canonical.length !== 1) return null;
  // Keys already stored as the same values (in any order) need no rewrite.
  const unchanged =
    canonical.length === keys.length && keys.every((key) => canonical.includes(key));
  return unchanged ? null : canonical;
}

type Option = NonNullable<QuizQuestion['options']>[number];

function resolveKey(
  type: QuizQuestion['type'],
  options: readonly Option[],
  key: string,
): string[] | null {
  if (typeof key !== 'string') return null;
  const byValue = options.filter((option) => option.value === key);
  if (byValue.length === 1) return [byValue[0]!.value];
  const byLabel = options.filter((option) => option.label === key);
  if (byLabel.length === 1) return [byLabel[0]!.value];
  if (byLabel.length > 1) return null;

  const byPrefix = options.filter((option) => isWholeWordPrefix(key, option.label));
  if (byPrefix.length === 1) return [byPrefix[0]!.value];

  if (type === 'multiple') return joinedLabels(options, key);
  return null;
}

/** `key` (minus trailing punctuation) starts `label` and ends on a word boundary. */
function isWholeWordPrefix(key: string, label: string): boolean {
  const prefix = key.trim().replace(/[\s.,;:!?…]+$/u, '');
  const text = label.trim();
  if (prefix.length < 3 || prefix.length >= text.length || !text.startsWith(prefix)) return false;
  return /[\s\p{P}]/u.test(text.charAt(prefix.length));
}

/** A key made of two or more whole labels and nothing but separators between them. */
function joinedLabels(options: readonly Option[], key: string): string[] | null {
  const contained = options
    .filter((option) => option.label.trim().length > 0 && key.includes(option.label))
    .sort((a, b) => b.label.length - a.label.length);
  if (contained.length < 2) return null;
  let rest = key;
  for (const option of contained) rest = rest.split(option.label).join(' ');
  if (!/^[\s,;|/&+·•\-]*(?:(?:and|or)[\s,;|/&+·•\-]*)*$/iu.test(rest)) return null;
  return contained.map((option) => option.value);
}
