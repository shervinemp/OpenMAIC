import { describe, expect, test } from 'vitest';
import type { QuizQuestion } from '@openmaic/dsl';
import { generateSceneContent } from '@openmaic/generation';
import type { SceneOutline } from '@/lib/types/generation';
import type { AICallFn } from '@/lib/generation/pipeline-types';

/**
 * Concept tags are produced with the quiz and normalized at the generation
 * boundary. The learning loop keys mastery by exact tag, so casing, list
 * markers, and duplicate paraphrase must not leak into the persisted question.
 */

function outline(id: string): SceneOutline {
  return {
    id,
    type: 'quiz',
    title: 'Recursion checkpoint',
    description: 'Assess understanding of recursion and base cases.',
    keyPoints: ['recursion', 'base case', 'call stack'],
    order: 2,
    quizConfig: { questionCount: 2, difficulty: 'medium', questionTypes: ['single'] },
  };
}

const rawQuiz = [
  {
    id: 'q1',
    type: 'single',
    question: 'What stops a recursive function from calling itself forever?',
    concepts: [' Recursion ', 'recursion.', 'Base Case', 'base case', 'Quiz'],
    options: [
      { value: 'A', label: 'A base case that returns without recursing' },
      { value: 'B', label: 'A larger input on every call' },
      { value: 'C', label: 'A global variable that counts calls' },
    ],
    answer: ['A'],
    analysis: 'Without a base case the recursive calls never reach a terminating branch.',
    points: 10,
  },
  {
    id: 'q2',
    type: 'single',
    question: 'Which structure records the pending calls of a recursive function?',
    concepts: 'call stack',
    options: [
      { value: 'A', label: 'The call stack' },
      { value: 'B', label: 'A hash table' },
      { value: 'C', label: 'The file system' },
    ],
    answer: ['A'],
    analysis: 'Each pending call is a stack frame, so the call stack holds them in order.',
    points: 10,
  },
];

describe('quiz concept tags', () => {
  test('normalizes, dedupes, and caps model-provided concepts', async () => {
    const aiCall: AICallFn = async () => JSON.stringify(rawQuiz);

    const result = await generateSceneContent(outline('quiz-concepts'), aiCall);
    expect(result).not.toBeNull();
    const questions = (result as { questions: QuizQuestion[] }).questions;

    expect(questions[0]?.concepts).toEqual(['recursion', 'base case']);
    expect(questions[1]?.concepts).toBeUndefined();
  });

  test('passes the key points and the tagging rule to the model', async () => {
    let seenSystem = '';
    let seenUser = '';
    const aiCall: AICallFn = async (system, user) => {
      seenSystem = system;
      seenUser = user;
      return JSON.stringify(rawQuiz);
    };

    await generateSceneContent(outline('quiz-concepts-prompt'), aiCall);

    expect(seenSystem).toContain('`concepts`');
    expect(seenSystem).toContain('lowercase');
    expect(seenUser).toContain('1. recursion');
    expect(seenUser).toContain('2. base case');
    expect(seenUser).toContain('`concepts`');
  });
});
