import { describe, expect, test } from 'vitest';

import { coerceChoiceQuestion, coerceFreeResponse } from '@/app/api/generate/exam/route';

/**
 * Exam items carry the same concept tags as quiz items. The coercion boundary
 * is where a model reply becomes a persisted exam spec, so malformed tags must
 * be dropped there rather than reaching the learning loop.
 */

const choice = {
  question: 'Which layer keeps raw events unchanged?',
  concepts: [' Bronze Layer ', 'bronze layer.', 'Quiz'],
  options: [
    { label: 'Bronze', value: 'A' },
    { label: 'Silver', value: 'B' },
    { label: 'Gold', value: 'C' },
  ],
  answer: ['A'],
  analysis: 'Bronze holds the raw ingestion output.',
};

const freeResponse = {
  prompt: 'Explain why the silver layer validates records before aggregation.',
  concepts: ['Data Quality', 'data quality', '1. Validation'],
  guidance: ['Name the failure a dirty record causes downstream.'],
  rubric: [
    { id: 'r1', criterion: 'Names validation', weight: 'essential', lookFor: 'A check' },
    { id: 'r2', criterion: 'Explains blast radius', weight: 'important', lookFor: 'Impact' },
  ],
  sampleAnswer: 'Validation prevents bad records from contaminating aggregates.',
  maxPoints: 10,
};

describe('exam concept tags', () => {
  test('normalizes choice-question concepts', () => {
    const question = coerceChoiceQuestion(choice, 0);
    expect(question?.concepts).toEqual(['bronze layer']);
  });

  test('normalizes free-response concepts', () => {
    const question = coerceFreeResponse(freeResponse, 0);
    expect(question?.concepts).toEqual(['data quality', 'validation']);
  });

  test('leaves a legacy item untagged', () => {
    const legacyChoice = { ...choice, concepts: undefined };
    const legacyFr = { ...freeResponse, concepts: undefined };
    expect(coerceChoiceQuestion(legacyChoice, 0)?.concepts).toBeUndefined();
    expect(coerceFreeResponse(legacyFr, 0)?.concepts).toBeUndefined();
  });
});
