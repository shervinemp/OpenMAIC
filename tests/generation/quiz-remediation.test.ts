import { describe, expect, test } from 'vitest';
import type { QuizQuestion } from '@openmaic/dsl';
import type { SceneOutline } from '@openmaic/generation';
import { attachQuizRemediation } from '@openmaic/generation';

function outline(
  overrides: Partial<SceneOutline> & Pick<SceneOutline, 'id' | 'order'>,
): SceneOutline {
  return {
    type: 'slide',
    title: overrides.id,
    description: '',
    keyPoints: [],
    ...overrides,
  } as SceneOutline;
}

function quiz(concepts: string[]): QuizQuestion {
  return {
    id: 'q1',
    type: 'single',
    question: 'Question?',
    options: [
      { value: 'A', label: 'right' },
      { value: 'B', label: 'wrong' },
    ],
    answer: ['A'],
    hasAnswer: true,
    concepts,
  };
}

describe('quiz remediation links', () => {
  test('links a question to the same-lesson teaching outline that covers its concepts', () => {
    const target = outline({ id: 'quiz', type: 'quiz', order: 5, lessonId: 'lesson-2' });
    const sameLesson = outline({
      id: 'teach-2',
      order: 4,
      lessonId: 'lesson-2',
      keyPoints: ['A recursive function needs a base case'],
    });
    const otherLesson = outline({
      id: 'teach-1',
      order: 2,
      lessonId: 'lesson-1',
      keyPoints: ['Recursion and induction'],
    });

    const [question] = attachQuizRemediation([quiz(['recursion'])], target, [
      otherLesson,
      sameLesson,
      target,
    ]);

    expect(question.remediationOutlineId).toBe('teach-2');
  });

  test('prefers the nearest teaching outline on a score tie', () => {
    const target = outline({ id: 'quiz', type: 'quiz', order: 6, lessonId: 'lesson-1' });
    const first = outline({ id: 'teach-1', order: 2, lessonId: 'lesson-1', keyPoints: ['tokens'] });
    const second = outline({
      id: 'teach-2',
      order: 4,
      lessonId: 'lesson-1',
      keyPoints: ['tokens'],
    });

    const [question] = attachQuizRemediation([quiz(['tokens'])], target, [first, second, target]);
    expect(question.remediationOutlineId).toBe('teach-2');
  });

  test('does not link across an unrelated candidate or an untagged item', () => {
    const target = outline({ id: 'quiz', type: 'quiz', order: 5, lessonId: 'lesson-1' });
    const unrelated = outline({
      id: 'teach',
      order: 3,
      lessonId: 'lesson-1',
      keyPoints: ['Photosynthesis converts light into sugar'],
    });

    const [tagged] = attachQuizRemediation([quiz(['recursion'])], target, [unrelated, target]);
    const [untagged] = attachQuizRemediation([quiz([])], target, [unrelated, target]);

    expect(tagged.remediationOutlineId).toBeUndefined();
    expect(untagged.remediationOutlineId).toBeUndefined();
  });

  test('ignores assessments and outlines that come after the quiz', () => {
    const target = outline({ id: 'quiz', type: 'quiz', order: 5, lessonId: 'lesson-1' });
    const laterReading = outline({
      id: 'later',
      order: 7,
      lessonId: 'lesson-1',
      keyPoints: ['recursion'],
    });
    const earlierQuiz = outline({
      id: 'earlier-quiz',
      type: 'quiz',
      order: 3,
      lessonId: 'lesson-1',
      keyPoints: ['recursion'],
    });

    const [question] = attachQuizRemediation([quiz(['recursion'])], target, [
      earlierQuiz,
      target,
      laterReading,
    ]);
    expect(question.remediationOutlineId).toBeUndefined();
  });

  test('clears a model-supplied link when no teaching outline matches', () => {
    const target = outline({ id: 'quiz', type: 'quiz', order: 5 });
    const [question] = attachQuizRemediation(
      [{ ...quiz(['recursion']), remediationOutlineId: 'made-up' }],
      target,
      [target],
    );
    expect(question.remediationOutlineId).toBeUndefined();
  });
});
