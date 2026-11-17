// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizQuestion } from '@/lib/types/stage';

const translations = vi.hoisted(() => ({
  'quiz.practice': 'Practice',
  'quiz.practiceMissed': 'Practice missed',
  'quiz.practiceAgain': 'Practice again',
  'quiz.backToQuiz': 'Back to quiz',
  'quiz.check': 'Check answer',
  'quiz.next': 'Next',
  'quiz.practiceComplete': 'Practice complete',
  'quiz.practiceNote': 'Practice attempts are not saved to your grade.',
  'quiz.excellent': 'Excellent!',
  'quiz.keepGoing': 'Keep going!',
  'quiz.needsReview': 'Needs review',
  'quiz.correct': 'correct',
  'quiz.incorrect': 'incorrect',
  'quiz.ungraded': 'Not graded',
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => translations[key as keyof typeof translations] ?? key,
    locale: 'en-US',
  }),
}));

import { QuizPractice } from '@/components/scene-renderers/quiz-view';

const question: QuizQuestion = {
  id: 'q1',
  type: 'single',
  question: 'What is 2 + 2?',
  options: [
    { value: 'A', label: '4' },
    { value: 'B', label: '5' },
  ],
  answer: ['A'],
  analysis: 'Two plus two is four.',
  hasAnswer: true,
  points: 1,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderPractice(questions: QuizQuestion[] = [question], onExit: () => void = () => {}) {
  act(() => {
    root.render(createElement(QuizPractice, { questions, locale: 'en-US', onExit }));
  });
}

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  expect(button, `button containing ${label}`).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('QuizPractice', () => {
  it('checks an answer and finishes the run', async () => {
    renderPractice();
    expect(container.textContent).toContain('1 / 1');

    await click('4');
    await click('Check answer');
    expect(container.textContent).toContain('Next');

    await click('Next');
    expect(container.textContent).toContain('Practice complete');
    expect(container.textContent).not.toContain('Practice missed (');
  });

  it('offers a missed-question retry after a wrong answer', async () => {
    renderPractice();

    await click('5');
    await click('Check answer');
    await click('Next');

    expect(container.textContent).toContain('Practice missed (1)');
    await click('Practice missed (1)');

    expect(container.textContent).toContain('What is 2 + 2?');
    expect(container.textContent).toContain('1 / 1');
  });

  it('leaves through the exit action', async () => {
    const onExit = vi.fn();
    renderPractice([question], onExit);

    await click('Back to quiz');
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('checks a numeric answer through the shared local grader', async () => {
    const numeric: QuizQuestion = {
      id: 'n1',
      type: 'numeric',
      question: 'How many centimeters are in 1.5 meters?',
      answer: ['150'],
      tolerance: 0,
      unit: 'cm',
      analysis: '1.5 m x 100 = 150 cm.',
      points: 1,
    };
    renderPractice([numeric]);

    const input = container.querySelector('input')!;
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      setValue.call(input, '150');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await click('Check answer');
    expect(container.textContent).toContain('Next');
    await click('Next');
    expect(container.textContent).toContain('Practice complete');
  });
});
