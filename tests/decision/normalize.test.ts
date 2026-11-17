import { describe, expect, it } from 'vitest';

import { normalizeDecisionResult } from '@/lib/decision/providers/normalize';
import type { DecisionQuestion } from '@/lib/decision/types';

const questions: DecisionQuestion[] = [
  {
    id: 'q1',
    kind: 'choice',
    prompt: 'Pick one',
    options: [
      { value: 'A', label: 'Base case' },
      { value: 'B', label: 'Bigger input' },
    ],
  },
  {
    id: 'q2',
    kind: 'choice',
    prompt: 'Pick many',
    options: [
      { value: 'A', label: 'One' },
      { value: 'B', label: 'Two' },
      { value: 'C', label: 'Three' },
    ],
    multiple: true,
  },
  { id: 's1', kind: 'score', prompt: 'Score it', min: 0, max: 10 },
  { id: 'n1', kind: 'noul', prompt: 'Is it met?' },
];

function normalize(raw: unknown, ignoreConfidence = false) {
  return normalizeDecisionResult({
    raw,
    questions,
    provider: 'test',
    latencyMs: 7,
    ignoreConfidence,
  });
}

describe('decision answer normalization', () => {
  it('maps values, labels, and arrays to option values', () => {
    const result = normalize({
      answers: {
        q1: { choice: 'Base case', confidence: 0.92 },
        q2: { choice: ['A', 'Three'], confidence: 84 },
        s1: { score: 14, confidence: 0.7 },
        n1: { noul: 0.81, confidence: 0.66 },
      },
    });

    expect(result.answers.get('q1')).toEqual({ kind: 'choice', values: ['A'], confidence: 0.92 });
    expect(result.answers.get('q2')).toEqual({
      kind: 'choice',
      values: ['A', 'C'],
      confidence: 0.84,
    });
    expect(result.answers.get('s1')).toEqual({ kind: 'score', value: 10, confidence: 0.7 });
    expect(result.answers.get('n1')).toEqual({ kind: 'noul', probability: 0.81, confidence: 0.66 });
    expect(result.abstained.size).toBe(0);
  });

  it('lowers a single-choice answer to one value and drops unknown options', () => {
    const result = normalize({
      answers: {
        q1: { choice: ['B', 'A'], confidence: 0.5 },
        q2: { choice: ['Z', 'B'], confidence: 0.5 },
      },
    });

    expect(result.answers.get('q1')).toMatchObject({ values: ['B'] });
    expect(result.answers.get('q2')).toMatchObject({ values: ['B'] });
  });

  it('marks missing, abstained, and review-routed answers as abstained', () => {
    const result = normalize({
      answers: {
        q1: { abstain: true },
        q2: { choice: 'A', confidence: 0.9 },
        n1: { route: 'review', noul: 0.9 },
      },
    });

    expect(result.abstained).toEqual(new Set(['q1', 's1', 'n1']));
    expect(result.answers.has('q2')).toBe(true);
  });

  it('accepts a result wrapper and an array of answers', () => {
    expect(
      normalize({
        result: {
          answers: [{ id: 's1', score: 3, confidence: 0.8 }],
        },
      }).answers.get('s1'),
    ).toMatchObject({ kind: 'score', value: 3 });

    expect(
      normalize({
        answers: { s1: 6 },
      }).answers.get('s1'),
    ).toMatchObject({ kind: 'score', value: 6, confidence: 0 });
  });

  it('never reports more confidence than the provider gave', () => {
    const result = normalize({ answers: { s1: { score: 6 } } });
    expect(result.answers.get('s1')).toMatchObject({ confidence: 0 });
  });

  it('can force uncalibrated confidence to zero', () => {
    const result = normalize({ answers: { s1: { score: 6, confidence: 0.99 } } }, true);
    expect(result.answers.get('s1')).toMatchObject({ confidence: 0 });
  });

  it('accepts numeric option values', () => {
    const numeric: DecisionQuestion[] = [
      {
        id: 'n1',
        kind: 'choice',
        prompt: 'Pick a number',
        options: [
          { value: '1', label: 'One' },
          { value: '2', label: 'Two' },
        ],
      },
    ];
    const result = normalizeDecisionResult({
      raw: { answers: { n1: { choice: 2, confidence: 0.9 } } },
      questions: numeric,
      provider: 'test',
      latencyMs: 1,
    });
    expect(result.answers.get('n1')).toMatchObject({ kind: 'choice', values: ['2'] });
  });

  it('clamps a probability and a negative score', () => {
    const result = normalize({
      answers: { n1: { probability: 1.4 }, s1: { score: -5 } },
    });
    expect(result.answers.get('n1')).toMatchObject({ probability: 1 });
    expect(result.answers.get('s1')).toMatchObject({ value: 0 });
  });
});
