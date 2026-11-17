import { describe, expect, test } from 'vitest';
import type { QuizQuestion } from '@openmaic/dsl';
import { generateSceneContent } from '@openmaic/generation';
import type { SceneOutline } from '@/lib/types/generation';
import type { AICallFn } from '@/lib/generation/pipeline-types';

/**
 * Option prose is learner-facing: rationale on every choice option,
 * misconception only on the wrong ones. The generation boundary must drop a
 * misconception attached to the key, strip both fields from ordering/matching
 * items, and attach a remediation outline from the course's key points.
 */

function quizOutline(): SceneOutline {
  return {
    id: 'quiz-1',
    type: 'quiz',
    title: 'Recursion checkpoint',
    description: 'Assess recursion and base cases.',
    keyPoints: ['recursion', 'base case'],
    order: 5,
    lessonId: 'lesson-1',
    quizConfig: {
      questionCount: 3,
      difficulty: 'medium',
      questionTypes: ['single', 'ordering', 'matching'],
    },
  };
}

const teachingOutline: SceneOutline = {
  id: 'teach-1',
  type: 'slide',
  title: 'Recursion',
  description: 'How recursive functions stop.',
  keyPoints: ['A recursive function needs a base case'],
  order: 3,
  lessonId: 'lesson-1',
};

const rawQuiz = [
  {
    id: 'q1',
    type: 'single',
    question: 'What stops a recursive function from calling itself forever?',
    concepts: ['recursion', 'base case'],
    options: [
      {
        value: 'A',
        label: 'A base case that returns without recursing',
        rationale: ' The base case ends the chain. ',
        misconception: 'This should be dropped from the key.',
      },
      {
        value: 'B',
        label: 'A larger input on every call',
        rationale: 'A larger input makes the chain longer.',
        misconception: ' A larger input always terminates recursion. ',
      },
      {
        value: 'C',
        label: 'A global variable that counts calls',
        rationale: 'Counting calls does not stop the recursion.',
        misconception: 'A counter can replace a base case.',
      },
    ],
    answer: ['A'],
    analysis: 'Without a base case the recursive calls never terminate.',
    points: 10,
  },
  {
    id: 'q2',
    type: 'ordering',
    question: 'Put these recursion steps in order',
    concepts: ['recursion'],
    options: [
      { value: 'A', label: 'Check the base case', rationale: 'not a distractor' },
      { value: 'B', label: 'Recurse on a smaller input', misconception: 'not a distractor' },
    ],
    analysis: 'Check the base case first, then recurse.',
    points: 10,
  },
  {
    id: 'q3',
    type: 'matching',
    question: 'Match each term with its meaning',
    concepts: ['recursion'],
    options: [
      { value: 'A', label: 'Base case', rationale: 'not a distractor' },
      { value: 'B', label: 'Recursive step' },
    ],
    matches: [
      { value: 'A', label: 'Stops the recursion', misconception: 'not a distractor' },
      { value: 'B', label: 'Moves toward the base case' },
    ],
    analysis: 'A base case stops, and the step moves toward it.',
    points: 10,
  },
];

describe('quiz option prose and remediation', () => {
  test('normalizes choice notes and strips them from non-choice items', async () => {
    const aiCall: AICallFn = async () => JSON.stringify(rawQuiz);

    const result = await generateSceneContent(quizOutline(), aiCall, {
      allOutlines: [teachingOutline, quizOutline()],
    });
    expect(result).not.toBeNull();
    const questions = (result as { questions: QuizQuestion[] }).questions;

    const single = questions[0]!;
    const ordering = questions[1]!;
    const matching = questions[2]!;
    expect(single.options?.[0]).toMatchObject({
      value: 'A',
      rationale: 'The base case ends the chain.',
    });
    expect(single.options?.[0]).not.toHaveProperty('misconception');
    expect(single.options?.[1]).toMatchObject({
      value: 'B',
      misconception: 'A larger input always terminates recursion.',
    });
    expect(single.remediationOutlineId).toBe('teach-1');

    for (const option of ordering.options ?? []) {
      expect(option).not.toHaveProperty('rationale');
      expect(option).not.toHaveProperty('misconception');
    }
    for (const option of [...(matching.options ?? []), ...(matching.matches ?? [])]) {
      expect(option).not.toHaveProperty('rationale');
      expect(option).not.toHaveProperty('misconception');
    }
  });
});
