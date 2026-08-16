/**
 * Specialized scene renderers (Phase 2 §15.4b).
 *
 * Exercise / derivation / glossary / reading outlines produce STRUCTURED
 * payloads (validated by the depth contract), which these renderers lay out
 * into slide elements. The rendered scene is a standard slide — the DSL
 * scene-type set stays closed — but the layout is purpose-built per kind
 * (worked-problem blocks, LaTeX derivation steps, term lists, annotated
 * reading lists) instead of the free-form slide-content layout.
 *
 * The raw elements returned here are still model-free and run through the
 * same post-pipeline as slide content (`fixElementDefaults`, LaTeX rendering,
 * id assignment) in scene-generator.ts.
 */

import type { GeneratedSlideData } from './pipeline-types';
import type {
  SceneOutline,
  ExerciseProblem,
  DerivationStep,
  GlossaryTerm,
  ReadingItem,
} from '@/lib/types/generation';

const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 562.5;
const MARGIN_X = 60;
const CONTENT_WIDTH = CANVAS_WIDTH - MARGIN_X * 2;
const TITLE_HEIGHT = 64;
const CONTENT_TOP = 104;
const CONTENT_BUDGET = CANVAS_HEIGHT - CONTENT_TOP - 20;

type ElementSpec = {
  kind: 'text' | 'latex';
  content: string; // inner HTML for text; the latex source for latex
  height: number;
  fontSize: number;
  /** Extra vertical gap reserved after this element. */
  gapAfter: number;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Conservative line estimate for a prose string at the given font size. */
function estimateHeight(plainText: string, fontSize: number): number {
  const charsPerLine = Math.max(16, Math.floor(CONTENT_WIDTH / (fontSize * 0.58)));
  const lines = Math.max(1, Math.ceil((plainText.replace(/\s+/g, ' ').length + 1) / charsPerLine));
  return Math.max(26, Math.ceil(lines * fontSize * 1.55) + 12);
}

function paragraph(inner: string, fontSize: number, extraStyle = ''): string {
  const style = `font-size:${fontSize}px;${extraStyle}`;
  return inner
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p style="${style}">${line}</p>`)
    .join('');
}

/** Fit the planned blocks into the canvas: shrink fonts proportionally when
 * the sum of heights would overflow (floor at 12px, one pass). */
function fitIntoCanvas(specs: ElementSpec[]): ElementSpec[] {
  const total =
    specs.reduce((sum, spec) => sum + spec.height + spec.gapAfter, 0) + TITLE_HEIGHT;
  if (total <= CANVAS_HEIGHT - 20) return specs;

  const available = CONTENT_BUDGET - specs.reduce((sum, spec) => sum + spec.gapAfter, 0);
  const used = specs.reduce((sum, spec) => sum + spec.height, 0);
  const factor = Math.min(1, available / used);
  return specs.map((spec) => {
    const fontSize = Math.max(12, Math.round(spec.fontSize * factor));
    const height =
      spec.kind === 'latex'
        ? Math.max(30, Math.round(spec.height * factor))
        : estimateHeight(spec.content.replace(/<[^>]+>/g, ''), fontSize);
    return { ...spec, fontSize, height };
  });
}

/** Lay the fitted blocks out top-down and convert them to slide elements. */
function layOut(specs: ElementSpec[]): GeneratedSlideData['elements'] {
  const elements: GeneratedSlideData['elements'] = [];
  let cursor = CONTENT_TOP;
  let index = 0;
  for (const spec of specs) {
    const id = `${spec.kind}_sp_${index++}`;
    if (spec.kind === 'latex') {
      elements.push({
        id,
        type: 'latex',
        left: MARGIN_X,
        top: cursor,
        width: CONTENT_WIDTH,
        height: spec.height,
        latex: spec.content,
        fixedRatio: false,
        align: 'center',
      });
    } else {
      elements.push({
        id,
        type: 'text',
        left: MARGIN_X,
        top: cursor,
        width: CONTENT_WIDTH,
        height: spec.height,
        content: spec.content,
        defaultFontName: '',
        defaultColor: '#333333',
      });
    }
    cursor += spec.height + spec.gapAfter;
  }
  return elements;
}

export function renderExerciseToElements(
  outline: SceneOutline,
  problems: ExerciseProblem[],
): GeneratedSlideData['elements'] {
  const multiple = problems.length > 1;
  const specs: ElementSpec[] = [];

  problems.forEach((problem, index) => {
    if (multiple) {
      specs.push({
        kind: 'text',
        content: paragraph(
          `<strong>Problem ${index + 1}</strong>`,
          multiple ? 15 : 16,
          'color:#5b9bd5;',
        ),
        height: 30,
        fontSize: multiple ? 15 : 16,
        gapAfter: 2,
      });
    }
    specs.push({
      kind: 'text',
      content: paragraph(escapeHtml(problem.statement), multiple ? 14 : 16),
      height: estimateHeight(problem.statement, multiple ? 14 : 16),
      fontSize: multiple ? 14 : 16,
      gapAfter: 6,
    });
    if (problem.hint?.trim()) {
      specs.push({
        kind: 'text',
        content: paragraph(`<em>Hint: ${escapeHtml(problem.hint)}</em>`, multiple ? 13 : 14),
        height: estimateHeight(problem.hint, multiple ? 13 : 14),
        fontSize: multiple ? 13 : 14,
        gapAfter: 6,
      });
    }
    specs.push({
      kind: 'text',
      content: paragraph(
        `<strong>Worked solution</strong><br>${escapeHtml(problem.solution)}`,
        multiple ? 13 : 15,
      ),
      height: estimateHeight(problem.solution, multiple ? 13 : 15) + 24,
      fontSize: multiple ? 13 : 15,
      gapAfter: 8,
    });
    if (problem.analysis?.trim()) {
      specs.push({
        kind: 'text',
        content: paragraph(
          `<strong>Analysis</strong> — ${escapeHtml(problem.analysis)}`,
          multiple ? 13 : 14,
        ),
        height: estimateHeight(problem.analysis, multiple ? 13 : 14) + 24,
        fontSize: multiple ? 13 : 14,
        gapAfter: 10,
      });
    }
  });

  return layOut(fitIntoCanvas(specs));
}

export function renderDerivationToElements(
  outline: SceneOutline,
  steps: DerivationStep[],
): GeneratedSlideData['elements'] {
  const specs: ElementSpec[] = [];
  const stepFont = steps.length > 3 ? 13 : 14;

  steps.forEach((step, index) => {
    const heading = step.claim?.trim()
      ? `<strong>Step ${index + 1} — ${escapeHtml(step.claim)}</strong>`
      : `<strong>Step ${index + 1}</strong>`;
    specs.push({
      kind: 'text',
      content: paragraph(heading, stepFont, 'color:#5b9bd5;'),
      height: 26,
      fontSize: stepFont,
      gapAfter: 2,
    });
    specs.push({
      kind: 'latex',
      content: step.latex,
      height: 44,
      fontSize: stepFont,
      gapAfter: 2,
    });
    specs.push({
      kind: 'text',
      content: paragraph(escapeHtml(step.explanation), stepFont),
      height: estimateHeight(step.explanation, stepFont),
      fontSize: stepFont,
      gapAfter: 10,
    });
  });

  return layOut(fitIntoCanvas(specs));
}

export function renderGlossaryToElements(
  outline: SceneOutline,
  terms: GlossaryTerm[],
): GeneratedSlideData['elements'] {
  const specs: ElementSpec[] = [];
  const font = terms.length > 5 ? 13 : 15;

  for (const term of terms) {
    const text = `<strong>${escapeHtml(term.term)}</strong> — ${escapeHtml(term.definition)}`;
    specs.push({
      kind: 'text',
      content: paragraph(text, font),
      height: estimateHeight(text.replace(/<[^>]+>/g, ''), font),
      fontSize: font,
      gapAfter: 8,
    });
  }

  return layOut(fitIntoCanvas(specs));
}

export function renderReadingToElements(
  outline: SceneOutline,
  items: ReadingItem[],
): GeneratedSlideData['elements'] {
  const specs: ElementSpec[] = [];
  const font = items.length > 4 ? 13 : 14;

  items.forEach((item, index) => {
    const sourcePart = item.source?.trim() ? ` <em>(${escapeHtml(item.source)})</em>` : '';
    const citation = item.citation?.trim() ? ` <span style="color:#5b9bd5;">${escapeHtml(item.citation)}</span>` : '';
    const head = `<strong>${index + 1}. ${escapeHtml(item.title)}</strong>${sourcePart}${citation}`;
    const body = escapeHtml(item.whyRead);
    const plain = `${index + 1}. ${item.title} ${item.source ?? ''} ${item.whyRead}`;
    specs.push({
      kind: 'text',
      content: paragraph(`${head}<br>${body}`, font),
      height: estimateHeight(plain, font) + 20,
      fontSize: font,
      gapAfter: 8,
    });
  });

  return layOut(fitIntoCanvas(specs));
}
