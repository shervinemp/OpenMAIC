import { describe, expect, it } from 'vitest';
import type { QuizQuestion } from '@openmaic/dsl';
import {
  blindQuizQuestions,
  quizAnswerDisagreements,
  summarizeQuizAnswerDisagreements,
} from '@openmaic/generation';
import {
  buildQuizVerifierPrompt,
  parseQuizVerifierResponse,
} from '@/lib/generation/quiz-answer-verifier';

function questions(): QuizQuestion[] {
  return [
    {
      id: 'q1',
      type: 'single',
      question: 'Which layer stores raw ingested data unchanged?',
      options: [
        { value: 'A', label: 'Bronze' },
        { value: 'B', label: 'Silver' },
        { value: 'C', label: 'Gold' },
      ],
      answer: ['A'],
      analysis: 'Bronze is the raw ingestion layer.',
      hasAnswer: true,
    },
    {
      id: 'q2',
      type: 'multiple',
      question: 'Which properties does a medallion architecture guarantee?',
      options: [
        { value: 'A', label: 'Progressive quality' },
        { value: 'B', label: 'Random sampling' },
        { value: 'C', label: 'Layer-specific contracts' },
      ],
      answer: ['A', 'C'],
      analysis: 'Each layer adds guarantees.',
      hasAnswer: true,
    },
    {
      id: 'q3',
      type: 'short_answer',
      question: 'Explain the silver layer.',
      hasAnswer: false,
    },
  ];
}

describe('blindQuizQuestions', () => {
  it('drops the key, the analysis and short-answer questions', () => {
    const blind = blindQuizQuestions(questions());

    expect(blind).toHaveLength(2);
    expect(blind[0]).toEqual({
      id: 'q1',
      type: 'single',
      question: 'Which layer stores raw ingested data unchanged?',
      options: [
        { value: 'A', label: 'Bronze' },
        { value: 'B', label: 'Silver' },
        { value: 'C', label: 'Gold' },
      ],
    });
    expect(JSON.stringify(blind)).not.toContain('Bronze is the raw ingestion layer');
    expect(JSON.stringify(blind)).not.toContain('"answer"');
    expect(JSON.stringify(blind)).not.toContain('hasAnswer');
  });
});

describe('quizAnswerDisagreements', () => {
  it('reports a differing single-choice key', () => {
    const findings = quizAnswerDisagreements(questions(), [
      { id: 'q1', answers: ['B'] },
      { id: 'q2', answers: ['A', 'C'] },
    ]);

    expect(findings).toEqual([
      {
        questionId: 'q1',
        question: 'Which layer stores raw ingested data unchanged?',
        marked: ['A'],
        solved: ['B'],
      },
    ]);
  });

  it('compares multiple-choice answers as sets', () => {
    expect(
      quizAnswerDisagreements(questions(), [
        { id: 'q1', answers: ['A'] },
        { id: 'q2', answers: ['C', 'A'] },
      ]),
    ).toEqual([]);
  });

  it('fails open on unknown ids, unknown option values and bad cardinality', () => {
    expect(
      quizAnswerDisagreements(questions(), [
        { id: 'missing', answers: ['A'] },
        { id: 'q1', answers: ['A', 'B'] },
        { id: 'q1', answers: ['Z'] },
      ]),
    ).toEqual([]);
  });

  it('returns nothing when verification produced no verdicts', () => {
    expect(quizAnswerDisagreements(questions(), [])).toEqual([]);
    expect(quizAnswerDisagreements(questions(), null)).toEqual([]);
  });
});

describe('quiz verifier prompt and parse', () => {
  it('builds a blind prompt from stems and options only', () => {
    const prompt = buildQuizVerifierPrompt(blindQuizQuestions(questions()));
    const body = `${prompt.system}\n${prompt.user}`;

    expect(body).toContain('answer key is NOT provided');
    expect(body).toContain('Bronze');
    expect(body).not.toContain('Bronze is the raw ingestion layer');
    expect(body).not.toContain('hasAnswer');
  });

  it('parses valid verdicts and drops values that are not options', () => {
    const blind = blindQuizQuestions(questions());
    const text = JSON.stringify({
      answers: [
        { id: 'q1', answers: ['B'] },
        { id: 'q2', answers: ['A', 'Z', 'C'] },
        { id: 'missing', answers: ['A'] },
      ],
    });

    expect(parseQuizVerifierResponse(text, blind)).toEqual([
      { id: 'q1', answers: ['B'] },
      { id: 'q2', answers: ['A', 'C'] },
    ]);
  });

  it('returns no verdicts for unparseable output', () => {
    const blind = blindQuizQuestions(questions());
    expect(parseQuizVerifierResponse('not json', blind)).toEqual([]);
    expect(parseQuizVerifierResponse('{"answers": "nope"}', blind)).toEqual([]);
  });
});

describe('summarizeQuizAnswerDisagreements', () => {
  it('names the key and the blind solve, and demands a full re-emit', () => {
    const feedback = summarizeQuizAnswerDisagreements([
      { questionId: 'q1', question: 'Which layer?', marked: ['A'], solved: ['B'] },
    ]);

    expect(feedback).toContain('blind solve');
    expect(feedback).toContain('key says A');
    expect(feedback).toContain('chose B');
    expect(feedback).toContain('complete corrected JSON array');
  });
});
