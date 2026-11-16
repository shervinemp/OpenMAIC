import { describe, expect, test, vi } from 'vitest';
import type { QuizQuestion } from '@openmaic/dsl';
import {
  generateSceneContent,
  readGenerationProfile,
  takeSceneDepthSummary,
  type SceneContentOptions,
  type QuizVerificationQuestion,
} from '@openmaic/generation';
import type { SceneOutline } from '@/lib/types/generation';
import type { AICallFn } from '@/lib/generation/pipeline-types';

/**
 * The blind verifier runs inside the quiz loop: a disagreement buys one
 * corrective re-prompt, not a quiz rejection. A verifier outage or a
 * disagreement on the final attempt keeps the generated keys.
 */

function outline(id: string): SceneOutline {
  return {
    id,
    type: 'quiz',
    title: 'Medallion checkpoint',
    description: 'Assess understanding of the bronze/silver/gold layers.',
    keyPoints: ['bronze', 'silver', 'gold'],
    order: 2,
    quizConfig: { questionCount: 2, difficulty: 'medium', questionTypes: ['single'] },
  };
}

function quiz(q1Key: string): QuizQuestion[] {
  return [
    {
      id: 'q1',
      type: 'single',
      question: 'Which layer keeps raw ingested data unchanged?',
      options: [
        { value: 'A', label: 'The bronze layer' },
        { value: 'B', label: 'The silver layer' },
        { value: 'C', label: 'The gold layer' },
      ],
      answer: [q1Key],
      analysis: 'Bronze holds the raw, unchanged ingestion output.',
      hasAnswer: true,
    },
    {
      id: 'q2',
      type: 'single',
      question: 'What does the medallion architecture enforce between layers?',
      options: [
        { value: 'A', label: 'Incremental quality improvements' },
        { value: 'B', label: 'Random sampling' },
        { value: 'C', label: 'Schema deletion' },
      ],
      answer: ['A'],
      analysis: 'Each layer adds quality guarantees.',
      hasAnswer: true,
    },
  ];
}

function options(verifyQuizAnswers?: SceneContentOptions['verifyQuizAnswers']) {
  return { languageDirective: 'Teach in English.', verifyQuizAnswers };
}

describe('quiz answer verification in the generation loop', () => {
  test('feeds a blind-solve disagreement into one corrective re-prompt', async () => {
    const target = outline('quiz-loop-corrected');
    const prompts: string[] = [];
    const aiCall: AICallFn = async (_system, user) => {
      prompts.push(user);
      return JSON.stringify(quiz(prompts.length === 1 ? 'A' : 'B'));
    };
    const verifier = vi.fn(async (_blind: readonly QuizVerificationQuestion[]) => [
      { id: 'q1', answers: ['B'] },
      { id: 'q2', answers: ['A'] },
    ]);

    const result = await generateSceneContent(target, aiCall, options(verifier));

    expect(result).not.toBeNull();
    const questions = (result as { questions: QuizQuestion[] }).questions;
    expect(questions[0]?.answer).toEqual(['B']);
    expect(prompts).toHaveLength(2);
    expect(verifier).toHaveBeenCalledTimes(2);
    // The second generation prompt carried the disagreement.
    expect(prompts[1]).toContain('blind solve');
    expect(prompts[1]).toContain('key says A');
    // The verifier never saw the stored key or analysis.
    const firstBlind = verifier.mock.calls[0]?.[0] as readonly QuizVerificationQuestion[];
    expect(firstBlind[0]).not.toHaveProperty('answer');
    expect(String(firstBlind[0]?.question)).not.toContain('raw, unchanged ingestion output');
    expect(takeSceneDepthSummary(target.id)).toMatchObject({
      reworked: true,
      attempts: 2,
      findings: [],
    });
  });

  test('a verifier failure is fail-open: one attempt, keys untouched', async () => {
    const target = outline('quiz-loop-fail-open');
    let calls = 0;
    const aiCall: AICallFn = async () => {
      calls += 1;
      return JSON.stringify(quiz('A'));
    };
    const verifier = vi.fn(async () => {
      throw new Error('verifier down');
    });

    const result = await generateSceneContent(target, aiCall, options(verifier));

    expect(result).not.toBeNull();
    expect((result as { questions: QuizQuestion[] }).questions[0]?.answer).toEqual(['A']);
    expect(calls).toBe(1);
  });

  test('keeps the generated keys when the final attempt still disagrees', async () => {
    const target = outline('quiz-loop-exhausted');
    let calls = 0;
    const aiCall: AICallFn = async () => {
      calls += 1;
      return JSON.stringify(quiz('A'));
    };
    const verifier = vi.fn(async () => [
      { id: 'q1', answers: ['B'] },
      { id: 'q2', answers: ['A'] },
    ]);

    const result = await generateSceneContent(target, aiCall, options(verifier));

    expect(result).not.toBeNull();
    expect((result as { questions: QuizQuestion[] }).questions[0]?.answer).toEqual(['A']);
    expect(calls).toBe(readGenerationProfile().contentAttempts + 1);
    const summary = takeSceneDepthSummary(target.id);
    expect(summary?.findings.join(' ')).toContain('may be wrong');
  });

  test('runs no verifier when the option is absent', async () => {
    const target = outline('quiz-loop-none');
    let calls = 0;
    const aiCall: AICallFn = async () => {
      calls += 1;
      return JSON.stringify(quiz('A'));
    };

    const result = await generateSceneContent(target, aiCall, options());

    expect(result).not.toBeNull();
    expect(calls).toBe(1);
  });
});
