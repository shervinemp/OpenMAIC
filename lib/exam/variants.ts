/**
 * Deterministic exam forms drawn from a generated question pool.
 *
 * Generation writes a pool (18 MC / 5 written) and a form size (12/3 for the
 * midterm, 14/4 for the final). Every attempt stores one seed; the same seed
 * always rebuilds the same subset, question order and MC option order. Retakes
 * and different learners therefore see different papers without another model
 * call.
 *
 * Option LETTERS are never re-lettered. `answer` keeps pointing at the same
 * stable option value, so an attempt's stored answers survive a shuffle and
 * review can always mark the correct option — only the on-screen order moves.
 */

import type {
  ExamAttempt,
  ExamChoiceQuestion,
  ExamFormConfig,
  ExamFreeResponse,
  ExamKind,
  ExamSpec,
} from '@/lib/types/exam';

export interface ExamVariant {
  seed: string;
  mcQuestions: ExamChoiceQuestion[];
  frQuestions: ExamFreeResponse[];
  /** Effective counts after capping at the pool size. */
  formConfig: ExamFormConfig;
}

/** Default form size when a spec carries a malformed `formConfig`. */
export const DEFAULT_EXAM_FORMS: Record<ExamKind, ExamFormConfig> = {
  midterm: { mcCount: 12, frCount: 3 },
  final: { mcCount: 14, frCount: 4 },
};

/** FNV-1a over UTF-16 code units: stable across engines and locales. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Small deterministic PRNG (mulberry32) keyed by a string seed. */
export function createExamRandom(seed: string): () => number {
  let state = hashSeed(seed) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Fisher-Yates over a copy; never mutates the caller's array. */
export function seededShuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

function clampCount(value: unknown, fallback: number, max: number): number {
  if (max <= 0) return 0;
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(1, parsed));
}

/**
 * The form actually drawn for a spec. A spec without `formConfig` is a legacy
 * exam: every question is used, in stored order, exactly as before variants
 * shipped.
 */
export function effectiveExamForm(spec: ExamSpec): ExamFormConfig {
  const mcMax = spec.mcQuestions?.length ?? 0;
  const frMax = spec.frQuestions?.length ?? 0;
  const config = spec.formConfig;
  if (!config) return { mcCount: mcMax, frCount: frMax };
  const fallback = DEFAULT_EXAM_FORMS[spec.kind] ?? DEFAULT_EXAM_FORMS.midterm;
  return {
    mcCount: clampCount(config.mcCount, fallback.mcCount, mcMax),
    frCount: clampCount(config.frCount, fallback.frCount, frMax),
  };
}

/** Build the seeded form an attempt sees. */
export function buildExamVariant(spec: ExamSpec, seed: string): ExamVariant {
  const formConfig = effectiveExamForm(spec);
  const random = createExamRandom(`${spec.kind}|${seed}|questions`);

  const mcQuestions = seededShuffle(spec.mcQuestions ?? [], random)
    .slice(0, formConfig.mcCount)
    .map((question) => ({
      ...question,
      options: seededShuffle(
        question.options ?? [],
        createExamRandom(`${spec.kind}|${seed}|${question.id}|options`),
      ),
    }));

  const frQuestions = seededShuffle(spec.frQuestions ?? [], random)
    .slice(0, formConfig.frCount)
    .map((question) => ({ ...question }));

  return { seed, mcQuestions, frQuestions, formConfig };
}

/**
 * Resolve the form for a stored attempt. Legacy attempts (no seed) used the
 * whole spec in stored order, so they keep that exact presentation.
 */
export function resolveAttemptVariant(
  spec: ExamSpec,
  attempt: Pick<ExamAttempt, 'variantSeed'>,
): ExamVariant {
  if (attempt.variantSeed) return buildExamVariant(spec, attempt.variantSeed);
  return {
    seed: '',
    mcQuestions: spec.mcQuestions ?? [],
    frQuestions: spec.frQuestions ?? [],
    formConfig: {
      mcCount: spec.mcQuestions?.length ?? 0,
      frCount: spec.frQuestions?.length ?? 0,
    },
  };
}

/** A fresh seed for a new attempt. `crypto.randomUUID` is available in browsers and Node 19+. */
export function createVariantSeed(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
