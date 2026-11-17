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
  'quiz.ordering': 'Ordering',
  'quiz.orderingHint': 'Put the items in the correct order.',
  'quiz.correctOrder': 'Correct order:',
  'quiz.moveUp': 'Move up',
  'quiz.moveDown': 'Move down',
  'quiz.matching': 'Matching',
  'quiz.matchingHint': 'Match each item on the left with one on the right.',
  'quiz.matchingChoose': 'Choose a match',
  'quiz.correctMatch': 'Correct match:',
  'quiz.yourAnswer': 'Your answer:',
  'quiz.notAnswered': 'Not answered',
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

  it('shuffles an ordering question and grades the restored sequence', async () => {
    const labels = ['Ingest raw events', 'Validate and clean', 'Aggregate into marts'];
    const ordering: QuizQuestion = {
      id: 'o1',
      type: 'ordering',
      question: 'Put the pipeline stages in the order they run.',
      options: labels.map((label, index) => ({ label, value: 'ABC'[index] })),
      analysis: 'Ingest, then clean, then aggregate.',
      hasAnswer: true,
      points: 1,
    };
    renderPractice([ordering]);

    const visible = () =>
      [...container.querySelectorAll('ol > li')].map(
        (row) => labels.find((label) => row.textContent?.includes(label))!,
      );

    // The stored order is the key, so the first paint must not show it.
    expect(visible()).not.toEqual(labels);
    expect([...visible()].sort()).toEqual([...labels].sort());

    const moveTo = async (label: string, target: number) => {
      for (let guard = 0; guard < labels.length + 1; guard += 1) {
        const rows = [...container.querySelectorAll('ol > li')];
        const position = rows.findIndex((row) => row.textContent?.includes(label));
        if (position === target) return;
        const button = [...rows[position].querySelectorAll('button')].find(
          (candidate) =>
            candidate.getAttribute('aria-label') === (position > target ? 'Move up' : 'Move down'),
        );
        expect(button, `move handle for ${label}`).toBeTruthy();
        await act(async () => {
          button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
      }
      throw new Error(`could not move ${label} to ${target}`);
    };

    await moveTo(labels[0], 0);
    await moveTo(labels[1], 1);
    expect(visible()).toEqual(labels);

    await click('Check answer');
    expect(container.textContent).toContain('Next');
    await click('Next');
    expect(container.textContent).toContain('Practice complete');
    expect(container.textContent).not.toContain('Practice missed (');
  });

  it('requires every matching pair before checking and grades the set', async () => {
    const matching: QuizQuestion = {
      id: 'm1',
      type: 'matching',
      question: 'Match each medallion layer with what it stores.',
      options: [
        { value: 'A', label: 'Bronze' },
        { value: 'B', label: 'Silver' },
      ],
      matches: [
        { value: 'A', label: 'Raw events' },
        { value: 'B', label: 'Cleaned records' },
      ],
      analysis: 'Bronze keeps raw events; silver holds cleaned records.',
      hasAnswer: true,
      points: 1,
    };
    renderPractice([matching]);

    const checkButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Check answer'),
    )!;
    expect(checkButton.disabled).toBe(true);

    const setSelect = async (index: number, value: string) => {
      const select = container.querySelectorAll('select')[index] as HTMLSelectElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value',
      )!.set!;
      await act(async () => {
        setter.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };

    await setSelect(0, 'A');
    expect(checkButton.disabled).toBe(true);
    await setSelect(1, 'B');
    expect(checkButton.disabled).toBe(false);

    await click('Check answer');
    expect(container.textContent).toContain('Next');
    await click('Next');
    expect(container.textContent).toContain('Practice complete');
    expect(container.textContent).not.toContain('Practice missed (');
  });
});
