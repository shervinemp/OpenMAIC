/**
 * One normalizer for every typed adapter.
 *
 * Laya, Jev, and the chat fallback all return JSON, but their field spellings
 * drift (`choice` vs `value`, `noul` vs `probability`, a scalar vs a list).
 * Normalizing in one place means a provider bug cannot leak a malformed answer
 * into a grader or verifier.
 */

import {
  UNREPORTED_CONFIDENCE,
  type DecisionAnswer,
  type DecisionQuestion,
  type DecisionResult,
} from '../types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Accept 0..1 or 0..100 confidence; absent or malformed means "unreported". */
function readConfidence(entry: Record<string, unknown>): number {
  const raw = asFiniteNumber(entry.confidence);
  if (raw === undefined) return UNREPORTED_CONFIDENCE;
  return clamp(raw > 1 ? raw / 100 : raw, 0, 1);
}

function readAnswers(raw: unknown): unknown {
  const record = asRecord(raw);
  if (!record) return undefined;
  const nested = asRecord(record.result);
  return record.answers ?? nested?.answers;
}

function answerEntries(raw: unknown): Map<string, unknown> {
  const entries = new Map<string, unknown>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const record = asRecord(item);
      const id = typeof record?.id === 'string' ? record.id.trim() : '';
      if (id) entries.set(id, record);
    }
    return entries;
  }
  const record = asRecord(raw);
  if (!record) return entries;
  for (const [id, value] of Object.entries(record)) entries.set(id, value);
  return entries;
}

function readChoiceValues(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((item) => readChoiceValues(item));
  const record = asRecord(value);
  if (!record) return [];
  return readChoiceValues(record.value ?? record.choice ?? record.label);
}

/**
 * Map a model's choice back to an option value. A decision head may answer
 * with the option value (`A`) or the visible label; a label match is safe and
 * keeps a correct answer from being discarded.
 */
function mapChoiceValues(
  rawValues: readonly string[],
  options: ReadonlyArray<{ value: string; label: string }>,
  multiple: boolean,
): string[] {
  const byValue = new Map(options.map((option) => [option.value, option.value]));
  const byLabel = new Map(
    options.map((option) => [option.label.trim().toLowerCase(), option.value]),
  );
  const mapped: string[] = [];
  for (const raw of rawValues) {
    const trimmed = raw.trim();
    const value = byValue.get(trimmed) ?? byLabel.get(trimmed.toLowerCase());
    if (value && !mapped.includes(value)) mapped.push(value);
  }
  return multiple ? mapped : mapped.slice(0, 1);
}

function readAnswer(question: DecisionQuestion, raw: unknown): DecisionAnswer | null {
  // A primitive entry is legal: `{"q1": "A"}` or `{"q1": 0.82}`.
  const entry =
    asRecord(raw) ?? (typeof raw === 'string' || typeof raw === 'number' ? { value: raw } : null);
  if (!entry) return null;
  if (entry.abstain === true || entry.route === 'review') return null;

  const confidence = readConfidence(entry);

  if (question.kind === 'choice') {
    const values = mapChoiceValues(
      readChoiceValues(entry.choice ?? entry.value ?? entry.answers ?? raw),
      question.options,
      question.multiple === true,
    );
    return values.length > 0 ? { kind: 'choice', values, confidence } : null;
  }

  if (question.kind === 'score') {
    const value = asFiniteNumber(entry.score ?? entry.value ?? raw);
    if (value === undefined) return null;
    return {
      kind: 'score',
      value: clamp(value, question.min, question.max),
      confidence,
    };
  }

  const probability = asFiniteNumber(entry.noul ?? entry.probability ?? entry.value ?? raw);
  if (probability === undefined) return null;
  return { kind: 'noul', probability: clamp(probability, 0, 1), confidence };
}

/**
 * Turn one provider payload into the canonical result. Unknown ids are
 * ignored, missing answers are recorded as abstained, and malformed answers
 * are dropped rather than guessed.
 */
export function normalizeDecisionResult(input: {
  raw: unknown;
  questions: readonly DecisionQuestion[];
  provider: string;
  latencyMs: number;
}): DecisionResult {
  const entries = answerEntries(readAnswers(input.raw));
  const answers = new Map<string, DecisionAnswer>();
  const abstained = new Set<string>();

  for (const question of input.questions) {
    const answer = readAnswer(question, entries.get(question.id));
    if (answer) answers.set(question.id, answer);
    else abstained.add(question.id);
  }

  return {
    provider: input.provider,
    answers,
    abstained,
    latencyMs: input.latencyMs,
  };
}
