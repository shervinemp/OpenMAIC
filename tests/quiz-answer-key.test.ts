import { describe, expect, test } from 'vitest';

import {
  answerIncludesOption,
  gradeChoiceQuestions,
  resolveAnswerKeyToValue,
} from '@/lib/quiz/grading';
import {
  findQuizOptionsContractFailure,
  generateSceneContent,
  normalizeNumericAnswer,
  normalizeNumericTolerance,
  normalizeOrderingOptions,
  normalizeQuizAnswer,
} from '../packages/@openmaic/generation/src/scene-generator';
import type { QuizQuestion } from '@/lib/types/stage';

const VECTOR_OPTIONS = [
  { value: 'A', label: '(6, 2)' },
  { value: 'B', label: '(2, -4)' },
  { value: 'C', label: '(6, -3)' },
  { value: 'D', label: '(6, -4)' },
];

function q(options: { value: string; label: string }[], answer?: string[]): QuizQuestion {
  return {
    id: 'qx',
    type: 'single',
    question: '?',
    options,
    answer: answer ?? ['A'], // 默认存储一个值键，供投影测试使用
    hasAnswer: true,
    points: 10,
  };
}

describe('resolveAnswerKeyToValue: exact alignment only', () => {
  test('exact option value resolves to itself', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), 'A')).toBe('A');
  });

  test('exact unique label resolves to that option value', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '(6, 2)')).toBe('A');
  });

  test('unknown key stays unresolved', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '(9, 9)')).toBe('(9, 9)');
  });

  test('ambiguous: two options sharing one label stays unresolved', () => {
    const dup = [
      { value: 'A', label: 'same' },
      { value: 'B', label: 'same' },
    ];
    expect(resolveAnswerKeyToValue(q(dup), 'same')).toBe('same');
  });
});

describe('negative cases: formatting differences are NOT silently equivalent', () => {
  test('case-differing key stays unresolved', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), 'a')).toBe('a');
  });

  test('whitespace-differing key stays unresolved', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '(6,2)')).toBe('(6,2)');
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '(6,  2)')).toBe('(6,  2)');
  });

  test('full-width wrapped key stays unresolved', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '（Ｂ）')).toBe('（Ｂ）');
  });

  test('wrapped/prefixed letter key stays unresolved', () => {
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), '(B)')).toBe('(B)');
    expect(resolveAnswerKeyToValue(q(VECTOR_OPTIONS), 'B.')).toBe('B.');
  });
});

describe('answerIncludesOption: exact resolver projection', () => {
  test('exact value and exact unique label both project to the option', () => {
    const question = q(VECTOR_OPTIONS, ['(6, 2)']); // label 存储
    expect(answerIncludesOption(question, 'A')).toBe(true); // label 解析后命中选项 A
    expect(answerIncludesOption(question, 'B')).toBe(false);
  });

  test('case/whitespace/full-width/wrapper differences project to false', () => {
    expect(answerIncludesOption(q(VECTOR_OPTIONS), 'a')).toBe(false);
    expect(answerIncludesOption(q(VECTOR_OPTIONS), '（Ｂ）')).toBe(false);
    expect(answerIncludesOption(q(VECTOR_OPTIONS), '(6,2)')).toBe(false);
  });

  test('ambiguous labels project to false for every option', () => {
    const dup = [
      { value: 'A', label: 'same' },
      { value: 'B', label: 'same' },
    ];
    const question = q(dup, ['same']); // 歧义存储：投影对任何选项都是 false
    expect(answerIncludesOption(question, 'A')).toBe(false);
    expect(answerIncludesOption(question, 'B')).toBe(false);
  });
});

describe('gradeChoiceQuestions: consumer paths', () => {
  test('persisted exact-label key grades correct in single-choice review', () => {
    const question: QuizQuestion = {
      id: 'q1',
      type: 'single',
      question: 'a+b=?',
      options: VECTOR_OPTIONS,
      answer: ['(6, 2)'], // 存储为 label（精确形态）
      hasAnswer: true,
      points: 10,
    };
    const results = gradeChoiceQuestions([question], { q1: 'A' });
    expect(results[0].correct).toBe(true);
  });

  test('multiple-choice with exact-value and exact-label keys grades correct', () => {
    const question: QuizQuestion = {
      id: 'q2',
      type: 'multiple',
      question: 'select all',
      options: VECTOR_OPTIONS,
      answer: ['A', '(2, -4)'], // 值 + 精确 label 混合存储
      hasAnswer: true,
      points: 10,
    };
    const results = gradeChoiceQuestions([question], { q2: ['A', 'B'] });
    expect(results[0].correct).toBe(true);
  });

  test('formatting-variant keys do NOT silently grade correct (negative)', () => {
    const question: QuizQuestion = {
      id: 'q3',
      type: 'single',
      question: '?',
      options: VECTOR_OPTIONS,
      answer: ['(6,2)'], // 无空格变体：与任何选项值/label 都不精确相等
      hasAnswer: true,
      points: 10,
    };
    const results = gradeChoiceQuestions([question], { q3: 'A' });
    expect(results[0].correct).toBe(false);
  });

  test('compatibility resolution applies to the persisted key only (negative)', () => {
    // 键是值键 A；提交的却是该选项的 label。只有持久化键才做兼容解析，
    // 提交按原值比较 —— label 提交必须判错，否则别名提交会被当成另一选项。
    const question: QuizQuestion = {
      id: 'q4',
      type: 'single',
      question: '?',
      options: VECTOR_OPTIONS,
      answer: ['A'],
      hasAnswer: true,
      points: 10,
    };
    expect(gradeChoiceQuestions([question], { q4: '(6, 2)' })[0].correct).toBe(false);
    // 同一道题，提交选项值本身仍判对。
    expect(gradeChoiceQuestions([question], { q4: 'A' })[0].correct).toBe(true);
  });
});

function coordinateQuizOutline() {
  return {
    id: 'quiz-1',
    type: 'quiz' as const,
    title: 'Coordinates',
    description: 'Pick a point.',
    keyPoints: ['Pairs'],
    order: 1,
    quizConfig: {
      questionCount: 1,
      difficulty: 'easy' as const,
      questionTypes: ['single' as const],
    },
  };
}

describe('generateSceneContent quiz option contract', () => {
  test('rejects a swapped value/label shape instead of repairing it', async () => {
    const failures: { code: string }[] = [];
    const content = await generateSceneContent(
      coordinateQuizOutline(),
      async () =>
        JSON.stringify([
          {
            id: 'q1',
            type: 'single',
            question: 'On the grid, which coordinate pair is written as (6, 2)?',
            analysis: 'The first value is x and the second is y.',
            options: [
              { value: '(6, 2)', label: 'a' },
              { value: '(2, -4)', label: 'b' },
            ],
            answer: ['a'],
          },
        ]),
      { onFailure: (failure) => failures.push(failure) },
    );

    expect(content).toBeNull();
    expect(failures).toEqual([{ code: 'invalid-model-output' }]);
  });

  test('persists a correct letter value and grades that submission', async () => {
    const content = await generateSceneContent(coordinateQuizOutline(), async () =>
      JSON.stringify([
        {
          id: 'q1',
          type: 'single',
          question: 'On the grid, which coordinate pair is written as (6, 2)?',
          analysis: 'The first value is x and the second is y.',
          options: [
            { value: 'A', label: '(6, 2)' },
            { value: 'B', label: '(2, -4)' },
          ],
          answer: ['A'],
        },
      ]),
    );

    expect(content && 'questions' in content).toBe(true);
    if (!content || !('questions' in content)) return;
    const question = content.questions[0];
    expect(question.options).toEqual([
      { value: 'A', label: '(6, 2)' },
      { value: 'B', label: '(2, -4)' },
    ]);
    expect(question.answer).toEqual(['A']);
    expect(gradeChoiceQuestions([question], { q1: 'A' })[0].correct).toBe(true);
    expect(gradeChoiceQuestions([question], { q1: 'a' })[0].correct).toBe(false);
    expect(gradeChoiceQuestions([question], { q1: '(6, 2)' })[0].correct).toBe(false);
  });

  test('rejects a lowercase key that does not equal an option value', async () => {
    const failures: { code: string }[] = [];
    const content = await generateSceneContent(
      coordinateQuizOutline(),
      async () =>
        JSON.stringify([
          {
            id: 'q1',
            type: 'single',
            question: 'On the grid, which coordinate pair is written as (6, 2)?',
            analysis: 'The first value is x and the second is y.',
            options: [
              { value: 'A', label: '(6, 2)' },
              { value: 'B', label: '(2, -4)' },
            ],
            answer: ['a'],
          },
        ]),
      { onFailure: (failure) => failures.push(failure) },
    );

    expect(content).toBeNull();
    expect(failures).toEqual([{ code: 'invalid-model-output' }]);
  });
});

describe('numeric quiz generation', () => {
  const numericQuestion: QuizQuestion = {
    id: 'n1',
    type: 'numeric',
    question: 'How many centimeters are in 1.5 meters?',
    answer: ['150'],
    tolerance: 0,
    unit: 'cm',
    analysis: '1.5 m x 100 cm/m = 150 cm.',
    hasAnswer: true,
  };

  test('normalizes the numeric answer aliases', () => {
    expect(normalizeNumericAnswer({ answer: 0.392 })).toEqual(['0.392']);
    expect(normalizeNumericAnswer({ correctAnswer: '1,234' })).toEqual(['1234']);
    expect(normalizeNumericAnswer({ answer: '0,392' })).toEqual(['0.392']);
    expect(normalizeNumericAnswer({ answer: [] })).toBeUndefined();
    expect(normalizeNumericAnswer({ answer: 'not a number' })).toBeUndefined();
  });

  test('keeps a negative tolerance for the contract to reject', () => {
    expect(normalizeNumericTolerance(-1)).toBe(-1);
    expect(normalizeNumericTolerance('abc')).toBeUndefined();
  });

  test('accepts a numeric question and rejects an invalid key or tolerance', () => {
    expect(findQuizOptionsContractFailure([numericQuestion])).toBeNull();
    expect(
      findQuizOptionsContractFailure([{ ...numericQuestion, answer: ['not a number'] }]),
    ).toContain('numeric');
    expect(findQuizOptionsContractFailure([{ ...numericQuestion, tolerance: -1 }])).toContain(
      'tolerance',
    );
  });
});

describe('ordering quiz generation', () => {
  const ordering: QuizQuestion = {
    id: 'o1',
    type: 'ordering',
    question: 'Put these stages in order.',
    options: [
      { value: 'A', label: 'Ingest' },
      { value: 'B', label: 'Clean' },
      { value: 'C', label: 'Aggregate' },
    ],
    analysis: 'The pipeline runs in this order.',
    hasAnswer: true,
  };

  test('accepts distinct items with no answer key', () => {
    expect(findQuizOptionsContractFailure([ordering])).toBeNull();
  });

  test('rejects fewer than two items', () => {
    const failing = [ordering, { ...ordering, options: [ordering.options![0]] }];
    expect(findQuizOptionsContractFailure(failing)).toContain('at least two');
  });

  test('rejects repeated item values', () => {
    const duplicate = {
      ...ordering,
      options: [
        { value: 'A', label: 'First' },
        { value: 'A', label: 'Second' },
      ],
    };
    expect(findQuizOptionsContractFailure([duplicate])).toContain('repeated');
  });

  test('honors an explicit correct sequence by permuting the items', () => {
    const normalized = normalizeOrderingOptions({
      options: [
        { label: 'Clean', value: 'A' },
        { label: 'Ingest', value: 'B' },
        { label: 'Aggregate', value: 'C' },
      ],
      answer: ['B', 'A', 'C'],
    });
    expect(normalized?.map((option) => option.label)).toEqual(['Ingest', 'Clean', 'Aggregate']);
  });

  test('ignores an incomplete or unknown correct sequence', () => {
    const options = [
      { label: 'Clean', value: 'A' },
      { label: 'Ingest', value: 'B' },
    ];
    expect(normalizeOrderingOptions({ options, answer: ['B'] })?.map((o) => o.value)).toEqual([
      'A',
      'B',
    ]);
    expect(normalizeOrderingOptions({ options, answer: ['B', 'Z'] })?.map((o) => o.value)).toEqual([
      'A',
      'B',
    ]);
  });

  test('normalizes plain string items to lettered options', () => {
    expect(normalizeOrderingOptions({ options: ['First', 'Second'] })).toEqual([
      { value: 'A', label: 'First' },
      { value: 'B', label: 'Second' },
    ]);
  });
});

describe('matching quiz generation', () => {
  const matching: QuizQuestion = {
    id: 'm1',
    type: 'matching',
    question: 'Match each layer with what it stores.',
    options: [
      { value: 'A', label: 'Bronze' },
      { value: 'B', label: 'Silver' },
    ],
    matches: [
      { value: 'A', label: 'Raw events' },
      { value: 'B', label: 'Cleaned records' },
    ],
    analysis: 'Bronze keeps raw events and silver holds cleaned records.',
    hasAnswer: true,
  };

  test('accepts aligned pairs with no answer key', () => {
    expect(findQuizOptionsContractFailure([matching])).toBeNull();
  });

  test('rejects fewer than two pairs', () => {
    const failing = [
      matching,
      {
        ...matching,
        options: [matching.options![0]],
        matches: [matching.matches![0]],
      },
    ];
    expect(findQuizOptionsContractFailure(failing)).toContain('at least two');
  });

  test('rejects columns of different length', () => {
    expect(
      findQuizOptionsContractFailure([{ ...matching, matches: [matching.matches![0]] }]),
    ).toContain('one right-hand item per left item');
  });

  test('rejects repeated right-hand labels as ambiguous', () => {
    const ambiguous = {
      ...matching,
      matches: [
        { value: 'A', label: 'Same' },
        { value: 'B', label: ' Same ' },
      ],
    };
    expect(findQuizOptionsContractFailure([ambiguous])).toContain('repeated');
  });
});

describe('normalizeQuizAnswer (generation): narrowed exact alignment', () => {
  test('exact value passes through', () => {
    expect(normalizeQuizAnswer({ answer: 'A' }, VECTOR_OPTIONS)).toEqual(['A']);
  });

  test('exact unique label resolves to the option value', () => {
    expect(normalizeQuizAnswer({ answer: '(6, 2)' }, VECTOR_OPTIONS)).toEqual(['A']);
  });

  test('formatting variants stay unresolved (fail closed)', () => {
    expect(normalizeQuizAnswer({ answer: '(6,2)' }, VECTOR_OPTIONS)).toEqual(['(6,2)']);
    expect(normalizeQuizAnswer({ answer: '（Ｂ）' }, VECTOR_OPTIONS)).toEqual(['（Ｂ）']);
  });

  test('ambiguous keys stay unresolved', () => {
    const dup = [
      { value: 'A', label: 'same' },
      { value: 'B', label: 'same' },
    ];
    expect(normalizeQuizAnswer({ answer: 'same' }, dup)).toEqual(['same']);
  });
});
