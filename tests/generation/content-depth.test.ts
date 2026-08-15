import { describe, expect, test } from 'vitest';
import {
  extractSlideTexts,
  isCaptionText,
  isIntroSummaryOutline,
  isSubstantiveText,
  recordSceneDepthReport,
  recordSceneDepthSummary,
  summarizeDepthFindings,
  takeSceneDepthReport,
  takeSceneDepthSummary,
  validateQuizDepth,
  validateSlideDepth,
} from '@/lib/generation/content-depth';
import type { PPTElement } from '@openmaic/dsl';
import type { QuizQuestion } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

function textElement(id: string, content: string): PPTElement {
  return {
    id,
    type: 'text',
    left: 0,
    top: 0,
    width: 100,
    height: 40,
    content,
    defaultFontName: '',
    defaultColor: '#000',
    rotate: 0,
  } as PPTElement;
}

function slideOutline(title: string, order = 1): SceneOutline {
  return {
    id: `s_${order}`,
    type: 'slide',
    title,
    description: 'Scene description.',
    keyPoints: ['a', 'b'],
    order,
  };
}

const SUBSTANTIVE = [
  textElement('t1', '<p>Evaporation moves water molecules from the liquid phase into vapor.</p>'),
  textElement('t2', '<p>Molecules gain energy when the liquid surface is heated by the sun.</p>'),
  textElement('t3', '<p>For example, a puddle shrinks much faster on a hot day than a cold one.</p>'),
  textElement('t4', '<p>Condensation reverses the process and returns vapor to liquid water.</p>'),
];

describe('text heuristics', () => {
  test('caption detector flags short noun phrases without verbs', () => {
    expect(isCaptionText('Bronze tables')).toBe(true);
    expect(isCaptionText('Raw files')).toBe(true);
    expect(isCaptionText('Declares pipeline steps')).toBe(false); // verb present
    expect(isCaptionText('A complete sentence that explains a concept in detail here')).toBe(false); // > 6 words
    expect(isCaptionText('')).toBe(false);
  });

  test('substantive detector flags complete claims', () => {
    expect(isSubstantiveText('Water changes into vapor when the surface is heated by sunlight.')).toBe(true);
    expect(isSubstantiveText('It is here')).toBe(false); // short verb phrase, < 5 words, < 40 chars
    expect(isSubstantiveText('Bronze tables')).toBe(false);
  });
});

describe('validateSlideDepth', () => {
  test('accepts a substantive slide with an example', () => {
    const report = validateSlideDepth(slideOutline('The Water Cycle'), SUBSTANTIVE);
    expect(report.adequate).toBe(true);
    expect(report.substantiveCount).toBe(4);
  });

  test('rejects the real-world caption-heavy deck (labeled diagram, not a lesson)', () => {
    // Mirrors the migrated Databricks course: 28 elements of 3-6 word fragments.
    const captionSlide: PPTElement[] = [
      textElement('c1', '<p>Bronze tables</p>'),
      textElement('c2', '<p>Raw files</p>'),
      textElement('c3', '<p>Silver tables</p>'),
      textElement('c4', '<p>Gold tables</p>'),
      textElement('c5', '<p>Ingestion stage</p>'),
      textElement('c6', '<p>Transformation stage</p>'),
    ];
    const report = validateSlideDepth(slideOutline('Delta Lake Architecture'), captionSlide);
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('caption fragments'))).toBe(true);
    expect(report.findings.some((f) => f.includes('substantive'))).toBe(true);
  });

  test('requires a concrete example unless intro/summary', () => {
    const noExample = SUBSTANTIVE.map((el, i) =>
      i === 2 ? textElement('t3', '<p>Humidity is the amount of water vapor present in the air.</p>') : el,
    );
    expect(validateSlideDepth(slideOutline('The Water Cycle'), noExample).adequate).toBe(false);
    // Intro scenes are exempt from the example requirement (Q5) but never from captions.
    const introReport = validateSlideDepth(slideOutline('Introduction'), noExample);
    expect(introReport.adequate).toBe(true);
  });

  test('rejects slides with no text at all', () => {
    const report = validateSlideDepth(slideOutline('The Water Cycle'), []);
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('no text elements'))).toBe(true);
  });

  test('extractSlideTexts strips HTML and skips non-text elements', () => {
    const texts = extractSlideTexts([
      textElement('a', '<p style="font-size: 14px;">Hello &amp; goodbye&nbsp;now</p>'),
      { id: 'img', type: 'image', left: 0, top: 0, width: 10, height: 10 } as PPTElement,
    ]);
    expect(texts).toEqual(['Hello & goodbye now']);
  });

  test('intro/summary detection covers common titles', () => {
    expect(isIntroSummaryOutline(slideOutline('Introduction'))).toBe(true);
    expect(isIntroSummaryOutline(slideOutline('Summary & Recap'))).toBe(true);
    expect(isIntroSummaryOutline(slideOutline('Delta Lake Architecture'))).toBe(false);
  });
});

describe('validateQuizDepth', () => {
  const quizOutline: SceneOutline = {
    id: 'q1',
    type: 'quiz',
    title: 'Checkpoint',
    description: 'Assess understanding.',
    keyPoints: ['a'],
    order: 2,
    quizConfig: { questionCount: 2, difficulty: 'medium', questionTypes: ['single'] },
  };

  function makeQuestions(): QuizQuestion[] {
    return [
      {
        id: 'q1',
        type: 'single',
        question: 'Which storage layer keeps raw ingested data unchanged?',
        options: [
          { value: 'A', label: 'The bronze layer' },
          { value: 'B', label: 'The gold layer' },
          { value: 'C', label: 'The serving layer' },
        ],
        answer: ['A'],
        analysis: 'Bronze holds the raw, unchanged ingestion output.',
        hasAnswer: true,
      },
      {
        id: 'q2',
        type: 'single',
        question: 'What does a medallion architecture enforce between layers?',
        options: [
          { value: 'A', label: 'Incremental quality improvements' },
          { value: 'B', label: 'Random sampling' },
        ],
        answer: ['A'],
        analysis: 'Each layer adds quality guarantees.',
        hasAnswer: true,
      },
    ];
  }

  test('accepts a substantive quiz', () => {
    expect(validateQuizDepth(quizOutline, makeQuestions()).adequate).toBe(true);
  });

  test('rejects count mismatches, bare stems, missing distractors and explanations', () => {
    const questions = makeQuestions();
    questions.pop(); // count mismatch
    questions[0].question = 'What is a bronze table?'; // bare recall
    questions[0].options = [{ value: 'A', label: 'X' }]; // one distractor
    questions[0].analysis = ''; // no explanation
    const report = validateQuizDepth(quizOutline, questions);
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('target is 2'))).toBe(true);
    expect(report.findings.some((f) => f.includes('bare recall'))).toBe(true);
    expect(report.findings.some((f) => f.includes('distractor'))).toBe(true);
    expect(report.findings.some((f) => f.includes('explanation'))).toBe(true);
  });
});

describe('feedback + failure side channel', () => {
  test('summarizeDepthFindings is concrete and actionable', () => {
    const report = validateSlideDepth(slideOutline('Delta Lake Architecture'), [
      textElement('c1', '<p>Bronze tables</p>'),
    ]);
    const summary = summarizeDepthFindings(report);
    expect(summary).toContain('depth contract');
    expect(summary).toContain('caption fragments');
  });

  test('record/take round-trips once', () => {
    const report = validateSlideDepth(slideOutline('X'), SUBSTANTIVE);
    recordSceneDepthReport('scene-1', report);
    expect(takeSceneDepthReport('scene-1')).toBe(report);
    expect(takeSceneDepthReport('scene-1')).toBeUndefined();
  });

  test('depth summary side channel round-trips once (reworked-for-depth affordance)', () => {
    const summary = { reworked: true, attempts: 2, findings: [] };
    recordSceneDepthSummary('scene-2', summary);
    expect(takeSceneDepthSummary('scene-2')).toEqual(summary);
    expect(takeSceneDepthSummary('scene-2')).toBeUndefined();
  });
});
