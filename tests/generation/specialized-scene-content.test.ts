import { describe, expect, test } from 'vitest';
import {
  validateDerivationDepth,
  validateExerciseDepth,
  validateGlossaryDepth,
  validateReadingDepth,
} from '@/lib/generation/content-depth';
import {
  renderDerivationToElements,
  renderExerciseToElements,
  renderGlossaryToElements,
  renderReadingToElements,
} from '@/lib/generation/specialized-scene-render';
import { isSlideLikeOutline, changeOutlineType } from '@/lib/generation/outline-type';
import { applyOutlineFallbacks } from '@/lib/generation/outline-generator';
import type {
  SceneOutline,
  ExerciseProblem,
  DerivationStep,
  GlossaryTerm,
  ReadingItem,
} from '@/lib/types/generation';

function outline(type: SceneOutline['type'], depthLevel?: SceneOutline['depthLevel']): SceneOutline {
  return {
    id: `${type}_1`,
    type,
    title: 'Specialized scene',
    description: 'Teach the technique.',
    keyPoints: ['a', 'b'],
    order: 1,
    ...(depthLevel ? { depthLevel } : {}),
  };
}

describe('validateExerciseDepth', () => {
  const worked: ExerciseProblem[] = [
    {
      id: 'p1',
      statement: 'A car accelerates from 0 to 20 m/s over 10 seconds. Find the distance.',
      solution: 'a = 20/10 = 2 m/s²; s = ½at² = ½·2·100 = 100 m.',
    },
  ];

  test('intro floor accepts one fully-worked problem', () => {
    expect(validateExerciseDepth(outline('exercise', 'intro'), worked).adequate).toBe(true);
  });

  test('rejects problems without worked solutions', () => {
    const report = validateExerciseDepth(
      outline('exercise'),
      [{ id: 'p1', statement: 'Find x.', solution: '' }],
    );
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('worked'))).toBe(true);
  });

  test('rejects bare-fragment statements', () => {
    const report = validateExerciseDepth(
      outline('exercise'),
      [{ id: 'p1', statement: 'The problem', solution: 's' }],
    );
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('fragment'))).toBe(true);
  });

  test('university floor needs two problems and analysis', () => {
    const one = validateExerciseDepth(outline('exercise', 'university'), worked);
    expect(one.adequate).toBe(false);
    expect(one.findings.some((f) => f.includes('at least 2'))).toBe(true);

    const second: ExerciseProblem = {
      id: 'p2',
      statement: 'A 2 kg mass hangs from a spring with k = 50 N/m. Find the extension.',
      solution: 'x = mg/k = 2·9.8/50 = 0.392 m.',
      analysis: 'Static equilibrium sets mg = kx; common error is forgetting g.',
    };
    expect(
      validateExerciseDepth(outline('exercise', 'university'), [
        { ...worked[0], analysis: 'Uniform acceleration applies.' },
        second,
      ]).adequate,
    ).toBe(true);
  });

  test('enforces citation minimum from retrieval context', () => {
    const retrieval = [
      '--- [source p.1] ---\nKinematics definitions.',
      '--- [source p.2] ---\nConstant-acceleration formulas.',
      '--- [source p.3] ---\nFriction models.',
    ].join('\n');
    const report = validateExerciseDepth(outline('exercise', 'university'), [
      {
        ...worked[0],
        analysis: 'The method works.',
      },
      {
        id: 'p2',
        statement: 'Q2 statement with concrete numbers and units.',
        solution: 'Worked solution.',
        analysis: 'Analysis.',
      },
    ], { retrievalContext: retrieval });
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('at least 3'))).toBe(true);
  });
});

describe('validateDerivationDepth', () => {
  const steps: DerivationStep[] = [
    { id: 'd1', latex: 'F = ma', explanation: 'Newton’s second law defines force as mass times acceleration.' },
    { id: 'd2', latex: 'v = v_0 + at', explanation: 'Integrating constant acceleration gives the velocity update.' },
  ];

  test('intro floor accepts two complete steps', () => {
    expect(validateDerivationDepth(outline('derivation', 'intro'), steps).adequate).toBe(true);
  });

  test('rejects steps missing latex or explanation', () => {
    const report = validateDerivationDepth(outline('derivation'), [
      { id: 'd1', latex: 'F = ma', explanation: '' },
      { id: 'd2', latex: '', explanation: 'explained' },
    ]);
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('latex formula'))).toBe(true);
    expect(report.findings.some((f) => f.includes('explanation'))).toBe(true);
  });

  test('rejects fragment explanations', () => {
    const report = validateDerivationDepth(outline('derivation'), [
      { id: 'd1', latex: 'F = ma', explanation: 'Second law' },
      { id: 'd2', latex: 'v = at', explanation: 'Velocity relation.' },
    ]);
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('fragment'))).toBe(true);
  });

  test('university floor needs four steps', () => {
    const four = [
      ...steps,
      { id: 'd3', latex: 's = v_0 t + \\frac{1}{2} a t^2', explanation: 'Integrating velocity gives displacement.' },
      { id: 'd4', latex: 'v^2 = v_0^2 + 2 a s', explanation: 'Eliminating time combines the previous two equations.' },
    ];
    expect(validateDerivationDepth(outline('derivation', 'university'), four).adequate).toBe(true);
    expect(validateDerivationDepth(outline('derivation', 'university'), steps).adequate).toBe(false);
  });
});

describe('validateGlossaryDepth', () => {
  const terms: GlossaryTerm[] = [
    { term: 'Latent heat', definition: 'Energy absorbed or released during a phase change at constant temperature.' },
    { term: 'Vapor pressure', definition: 'The pressure exerted by a vapor in equilibrium with its liquid.' },
    { term: 'Dew point', definition: 'The temperature at which air becomes saturated with water vapor.' },
    { term: 'Relative humidity', definition: 'The ratio of actual vapor pressure to saturation vapor pressure.' },
  ];

  test('intro floor accepts four complete terms', () => {
    expect(validateGlossaryDepth(outline('glossary', 'intro'), terms).adequate).toBe(true);
  });

  test('rejects missing definitions and fragments', () => {
    const report = validateGlossaryDepth(outline('glossary'), [
      { term: 'Latent heat', definition: '' },
      { term: 'Vapor pressure', definition: 'A pressure' },
    ]);
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('at least 4'))).toBe(true);
    expect(report.findings.some((f) => f.includes('missing its definition'))).toBe(true);
    expect(report.findings.some((f) => f.includes('fragment'))).toBe(true);
  });

  test('university floor needs six terms', () => {
    const six = [
      ...terms,
      { term: 'Adiabatic', definition: 'A process where no heat is exchanged with the surroundings.' },
      { term: 'Enthalpy', definition: 'Total heat content of a system at constant pressure.' },
    ];
    expect(validateGlossaryDepth(outline('glossary', 'university'), six).adequate).toBe(true);
    expect(validateGlossaryDepth(outline('glossary', 'university'), terms).adequate).toBe(false);
  });
});

describe('validateReadingDepth', () => {
  const items: ReadingItem[] = [
    { title: 'The Feynman Lectures on Physics', source: 'Feynman et al.', whyRead: 'A classic narrative treatment that deepens the intuition behind the scene’s concepts.' },
    { title: 'Thermodynamics textbook chapter 3', whyRead: 'Rigorous derivations of the phase-change energetics covered here.' },
    { title: 'IUPAC standard tables', whyRead: 'Authoritative reference values for the constants used in the worked example.' },
  ];

  test('intro floor accepts three annotated items', () => {
    expect(validateReadingDepth(outline('reading', 'intro'), items).adequate).toBe(true);
  });

  test('rejects items missing why-read annotations', () => {
    const report = validateReadingDepth(outline('reading'), [
      { title: 'A book', whyRead: '' },
      { title: 'A paper', whyRead: 'Explains the method.' },
    ]);
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('why-read'))).toBe(true);
    expect(report.findings.some((f) => f.includes('at least 3'))).toBe(true);
  });

  test('university floor needs five items', () => {
    const five = [
      ...items,
      { title: 'Original research paper', whyRead: 'Primary source for the result derived in this unit.' },
      { title: 'Review article', whyRead: 'Survey of competing interpretations.' },
    ];
    expect(validateReadingDepth(outline('reading', 'university'), five).adequate).toBe(true);
    expect(validateReadingDepth(outline('reading', 'university'), items).adequate).toBe(false);
  });
});

describe('specialized scene renderers', () => {
  test('exercise renderer lays out a worked problem within the canvas', () => {
    const elements = renderExerciseToElements(outline('exercise'), [
      {
        id: 'p1',
        statement: 'Find the distance.',
        solution: 'Use s = vt.',
        analysis: 'The method works.',
      },
    ]);
    expect(elements.length).toBeGreaterThan(0);
    const texts = elements.filter((el) => el.type === 'text');
    expect(texts.some((el) => String((el as { content?: string }).content).includes('Worked solution'))).toBe(true);
    for (const el of elements) {
      const box = el as { left: number; top: number; width: number; height: number };
      expect(box.top + box.height).toBeLessThanOrEqual(562.5);
      expect(box.left).toBe(60);
      expect(box.width).toBe(880);
    }
  });

  test('derivation renderer emits latex elements', () => {
    const elements = renderDerivationToElements(outline('derivation'), [
      { id: 'd1', latex: 'F = ma', explanation: 'Second law.' },
      { id: 'd2', latex: 'v = at', explanation: 'Integration.' },
    ]);
    const latexElements = elements.filter((el) => el.type === 'latex');
    expect(latexElements.length).toBe(2);
    expect((latexElements[0] as unknown as { latex: string }).latex).toBe('F = ma');
  });

  test('renderers escape HTML in LLM prose', () => {
    const elements = renderGlossaryToElements(outline('glossary'), [
      { term: '<b>Term</b>', definition: 'Definition with <script>alert(1)</script> injection.' },
    ]);
    const content = String((elements[0] as { content?: string }).content);
    expect(content).not.toContain('<script>');
    expect(content).toContain('&lt;script&gt;');
  });

  test('glossary and reading renderers stay within the canvas at university floors', () => {
    const glossaryTerms = Array.from({ length: 6 }, (_, i) => ({
      term: `Term ${i}`,
      definition: `A complete definition sentence for term number ${i} in the unit glossary.`,
    }));
    for (const el of renderGlossaryToElements(outline('glossary', 'university'), glossaryTerms)) {
      const box = el as { top: number; height: number };
      expect(box.top + box.height).toBeLessThanOrEqual(562.5);
    }

    const readingItems = Array.from({ length: 5 }, (_, i) => ({
      title: `Reading item ${i}`,
      whyRead: `What the learner gains from reading item number ${i} after this scene.`,
    }));
    for (const el of renderReadingToElements(outline('reading', 'university'), readingItems)) {
      const box = el as { top: number; height: number };
      expect(box.top + box.height).toBeLessThanOrEqual(562.5);
    }
  });
});

describe('outline integration', () => {
  test('isSlideLikeOutline covers slide + the four specialized kinds', () => {
    expect(isSlideLikeOutline(outline('slide'))).toBe(true);
    expect(isSlideLikeOutline(outline('exercise'))).toBe(true);
    expect(isSlideLikeOutline(outline('derivation'))).toBe(true);
    expect(isSlideLikeOutline(outline('glossary'))).toBe(true);
    expect(isSlideLikeOutline(outline('reading'))).toBe(true);
    expect(isSlideLikeOutline(outline('quiz'))).toBe(false);
    expect(isSlideLikeOutline(outline('interactive'))).toBe(false);
    expect(isSlideLikeOutline(outline('pbl'))).toBe(false);
  });

  test('changeOutlineType switches to specialized kinds and survives fallbacks', () => {
    for (const type of ['exercise', 'derivation', 'glossary', 'reading'] as const) {
      const changed = changeOutlineType(outline('slide'), type);
      expect(changed.type).toBe(type);
      expect(applyOutlineFallbacks(changed, true).type).toBe(type);
    }
  });
});
