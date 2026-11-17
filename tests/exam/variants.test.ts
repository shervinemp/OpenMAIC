import { describe, expect, it } from 'vitest';
import type { ExamChoiceQuestion, ExamSpec } from '@/lib/types/exam';
import {
  buildExamVariant,
  createExamRandom,
  createVariantSeed,
  effectiveExamForm,
  resolveAttemptVariant,
  seededShuffle,
} from '@/lib/exam/variants';

function choice(index: number): ExamChoiceQuestion {
  return {
    id: `mc_${index}`,
    question: `Question ${index}?`,
    options: [
      { label: `Answer ${index}A`, value: 'A' },
      { label: `Answer ${index}B`, value: 'B' },
      { label: `Answer ${index}C`, value: 'C' },
      { label: `Answer ${index}D`, value: 'D' },
    ],
    answer: ['B'],
    analysis: 'Because B.',
    points: 1,
  };
}

function spec(overrides: Partial<ExamSpec> = {}): ExamSpec {
  return {
    kind: 'midterm',
    title: 'Midterm Exam',
    coverage: 'Units 1-2',
    unitRange: { from: 0, to: 1 },
    mcQuestions: Array.from({ length: 18 }, (_, index) => choice(index + 1)),
    frQuestions: Array.from({ length: 5 }, (_, index) => ({
      id: `fr_${index + 1}`,
      prompt: `Written task ${index + 1}`,
      rubric: [
        { id: `r${index}a`, criterion: 'criterion a', weight: 'essential' as const, lookFor: 'a' },
        { id: `r${index}b`, criterion: 'criterion b', weight: 'important' as const, lookFor: 'b' },
      ],
      sampleAnswer: 'sample',
      maxPoints: 10,
    })),
    formConfig: { mcCount: 12, frCount: 3 },
    timing: { mcSec: 1500, frSec: 2100 },
    generatedAt: 1,
    ...overrides,
  };
}

describe('seeded exam variants', () => {
  it('rebuilds the same form and option order for the same seed', () => {
    const first = buildExamVariant(spec(), 'seed-one');
    const second = buildExamVariant(spec(), 'seed-one');
    expect(second).toEqual(first);
  });

  it('draws materially different forms for different seeds', () => {
    const ids = new Set(
      ['seed-a', 'seed-b', 'seed-c', 'seed-d'].map((seed) =>
        buildExamVariant(spec(), seed)
          .mcQuestions.map((question) => question.id)
          .join(','),
      ),
    );
    expect(ids.size).toBeGreaterThan(1);
  });

  it('draws the configured form size without duplicates', () => {
    const variant = buildExamVariant(spec(), 'seed-one');
    expect(variant.formConfig).toEqual({ mcCount: 12, frCount: 3 });
    expect(variant.mcQuestions).toHaveLength(12);
    expect(variant.frQuestions).toHaveLength(3);
    expect(new Set(variant.mcQuestions.map((question) => question.id)).size).toBe(12);
    const poolIds = new Set(spec().mcQuestions.map((question) => question.id));
    for (const question of variant.mcQuestions) expect(poolIds.has(question.id)).toBe(true);
  });

  it('shuffles options without changing the labels, values or correct answer', () => {
    const source = spec();
    const variant = buildExamVariant(source, 'seed-options');
    for (const question of variant.mcQuestions) {
      const original = source.mcQuestions.find((entry) => entry.id === question.id)!;
      expect([...question.options].sort((a, b) => a.value.localeCompare(b.value))).toEqual(
        [...original.options].sort((a, b) => a.value.localeCompare(b.value)),
      );
      const correctLabel = original.options.find((option) => option.value === question.answer[0]);
      const variantCorrect = question.options.find((option) => option.value === question.answer[0]);
      expect(variantCorrect?.label).toBe(correctLabel?.label);
    }
    // At least one question's option order actually moved for this seed.
    expect(
      variant.mcQuestions.some(
        (question) => question.options.map((option) => option.value).join('') !== 'ABCD',
      ),
    ).toBe(true);
  });

  it('caps an undersized pool instead of repeating questions', () => {
    const small = spec({
      mcQuestions: spec().mcQuestions.slice(0, 5),
      frQuestions: spec().frQuestions.slice(0, 2),
      formConfig: { mcCount: 12, frCount: 3 },
    });
    const variant = buildExamVariant(small, 'seed-small');
    expect(variant.mcQuestions).toHaveLength(5);
    expect(variant.frQuestions).toHaveLength(2);
    expect(variant.formConfig).toEqual({ mcCount: 5, frCount: 2 });
  });

  it('uses every question for a legacy spec without formConfig', () => {
    const legacy = spec({ formConfig: undefined });
    expect(effectiveExamForm(legacy)).toEqual({ mcCount: 18, frCount: 5 });
    const variant = resolveAttemptVariant(legacy, { variantSeed: undefined });
    expect(variant.mcQuestions.map((question) => question.id)).toEqual(
      legacy.mcQuestions.map((question) => question.id),
    );
    expect(variant.frQuestions.map((question) => question.id)).toEqual(
      legacy.frQuestions.map((question) => question.id),
    );
  });

  it('rebuilds a stored seed on review and survives malformed form config', () => {
    const stored = spec({ formConfig: { mcCount: Number.NaN, frCount: -4 } });
    const variant = resolveAttemptVariant(stored, { variantSeed: 'stored-seed' });
    expect(variant.formConfig).toEqual({ mcCount: 12, frCount: 1 });
    expect(variant).toEqual(buildExamVariant(stored, 'stored-seed'));
  });

  it('is deterministic across the shuffle and PRNG primitives', () => {
    const random = createExamRandom('stable');
    expect(seededShuffle([1, 2, 3, 4, 5], random)).toEqual(
      seededShuffle([1, 2, 3, 4, 5], createExamRandom('stable')),
    );
    expect(createVariantSeed()).toMatch(/\S/);
  });
});
