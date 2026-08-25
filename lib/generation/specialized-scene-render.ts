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
  GeneratedComparisonContent,
  GeneratedDataReadingContent,
  GeneratedTradeoffsContent,
  GeneratedFreeResponseContent,
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

// ==================== Analytic kinds (Phase 2 §15.9) ====================

export function renderComparisonToElements(
  outline: SceneOutline,
  content: GeneratedComparisonContent,
): GeneratedSlideData['elements'] {
  const specs: ElementSpec[] = [];
  const subjects = content.subjects ?? [];
  const rows = (content.rows ?? []).filter((row) => row.dimension?.trim());
  const manyRows = rows.length > 4;
  const dimFont = manyRows ? 13 : 14;
  const cellFont = manyRows ? 12 : 13;

  // Column header: Dimension | subject per column.
  specs.push({
    kind: 'text',
    content: paragraph(
      `<strong>Dimension</strong>${subjects.map((s) => ` &nbsp;|&nbsp; <strong>${escapeHtml(s)}</strong>`).join('')}`,
      dimFont,
      'color:#5b9bd5;',
    ),
    height: 28,
    fontSize: dimFont,
    gapAfter: 4,
  });

  for (const row of rows) {
    const cellsHtml = subjects
      .map((subject, index) => {
        const cell = row.cells?.[index]?.trim();
        return cell ? `<em>${escapeHtml(subject)}:</em> ${escapeHtml(cell)}` : '';
      })
      .filter(Boolean)
      .join('<br>');
    if (!cellsHtml) continue;
    const plain = `${row.dimension} ${subjects.join(' ')} ${(row.cells ?? []).join(' ')}`;
    specs.push({
      kind: 'text',
      content: paragraph(`<strong>${escapeHtml(row.dimension)}</strong><br>${cellsHtml}`, cellFont),
      height: estimateHeight(plain, cellFont) + 18,
      fontSize: cellFont,
      gapAfter: 8,
    });
  }

  for (const takeaway of content.takeaways ?? []) {
    if (!takeaway?.trim()) continue;
    specs.push({
      kind: 'text',
      content: paragraph(
        `<strong>Takeaway</strong> — ${escapeHtml(takeaway)}`,
        cellFont,
        'border-left:3px solid #5b9bd5;padding-left:8px;',
      ),
      height: estimateHeight(takeaway, cellFont) + 16,
      fontSize: cellFont,
      gapAfter: 6,
    });
  }

  return layOut(fitIntoCanvas(specs));
}

export function renderDataReadingToElements(
  outline: SceneOutline,
  content: GeneratedDataReadingContent,
): GeneratedSlideData['elements'] {
  const specs: ElementSpec[] = [];
  const claims = (content.claims ?? []).filter((claim) => claim.statement?.trim());
  const bodyFont = claims.length > 3 ? 12 : 13;

  // Chart description block: what is plotted, on which axes.
  const axes = `${content.xAxisLabel ?? ''} → ${content.yAxisLabel ?? ''}`;
  const unitNote = content.unitNote?.trim() ? `<br><em>${escapeHtml(content.unitNote)}</em>` : '';
  specs.push({
    kind: 'text',
    content: paragraph(
      `<strong>${escapeHtml(content.chartTitle || outline.title)}</strong> (${escapeHtml(content.chartType)})<br>${escapeHtml(axes)}${unitNote}`,
      bodyFont,
      'color:#5b9bd5;',
    ),
    height: 52,
    fontSize: bodyFont,
    gapAfter: 6,
  });

  // The plotted values, compactly — the "chart" a learner reads.
  for (const series of content.series ?? []) {
    const pointsText = (series.points ?? [])
      .map((p) => `${p.x}→${p.y}`)
      .join('&nbsp;&nbsp; ');
    if (!pointsText) continue;
    const text = `${escapeHtml(series.name || 'series')}: ${pointsText}`;
    specs.push({
      kind: 'text',
      content: paragraph(text, bodyFont),
      height: estimateHeight(text.replace(/&nbsp;/g, ' '), bodyFont),
      fontSize: bodyFont,
      gapAfter: 4,
    });
  }
  specs.push({ kind: 'text', content: '', height: 10, fontSize: bodyFont, gapAfter: 2 });

  // Claims with their verdicts.
  const verdictStyle: Record<string, string> = {
    supported: 'color:#3f9950;',
    refuted: 'color:#c0504d;',
    insufficient: 'color:#b8860b;',
  };
  claims.forEach((claim, index) => {
    const verdict = String(claim.verdict);
    const label = verdict.charAt(0).toUpperCase() + verdict.slice(1);
    const head = `<strong>Claim ${index + 1}</strong> — <span style="${verdictStyle[verdict] ?? ''}"><strong>${label}</strong></span>`;
    const body = escapeHtml(claim.statement);
    const why = claim.explanation?.trim()
      ? `<br><em>Why:</em> ${escapeHtml(claim.explanation)}`
      : '';
    const plain = `${claim.statement} ${claim.explanation ?? ''}`;
    specs.push({
      kind: 'text',
      content: paragraph(`${head}<br>${body}${why}`, bodyFont),
      height: estimateHeight(plain, bodyFont) + 30,
      fontSize: bodyFont,
      gapAfter: 8,
    });
  });

  return layOut(fitIntoCanvas(specs));
}

export function renderTradeoffsToElements(
  outline: SceneOutline,
  content: GeneratedTradeoffsContent,
): GeneratedSlideData['elements'] {
  const specs: ElementSpec[] = [];
  const options_ = (content.options ?? []).filter((option) => option.name?.trim());
  const bodyFont = options_.length > 2 ? 12 : 13;

  if (content.context?.trim()) {
    specs.push({
      kind: 'text',
      content: paragraph(
        `<strong>Decision</strong> — ${escapeHtml(content.context)}`,
        bodyFont,
      ),
      height: estimateHeight(content.context, bodyFont) + 14,
      fontSize: bodyFont,
      gapAfter: 6,
    });
  }

  const constraints = (content.constraints ?? []).filter((c) => c?.trim());
  if (constraints.length > 0) {
    specs.push({
      kind: 'text',
      content: paragraph(
        `<strong>Constraints</strong> — ${constraints.map((c) => escapeHtml(c)).join(' &nbsp;•&nbsp; ')}`,
        bodyFont,
        'color:#b8860b;',
      ),
      height: estimateHeight(constraints.join(' '), bodyFont) + 12,
      fontSize: bodyFont,
      gapAfter: 8,
    });
  }

  for (const option of options_) {
    const pros = (option.pros ?? []).filter(Boolean);
    const cons = (option.cons ?? []).filter(Boolean);
    const bestFor = option.bestFor?.trim()
      ? `<br><em>Best for:</em> ${escapeHtml(option.bestFor)}`
      : '';
    const head = `<strong>${escapeHtml(option.name)}</strong>`;
    const proLine = pros.length > 0 ? `<span style="color:#3f9950;">+ ${pros.map((p) => escapeHtml(p)).join('; + ')}</span>` : '';
    const conLine = cons.length > 0 ? `<br><span style="color:#c0504d;">− ${cons.map((c) => escapeHtml(c)).join('; − ')}</span>` : '';
    const plain = `${option.name} ${pros.join(' ')} ${cons.join(' ')} ${option.bestFor ?? ''}`;
    specs.push({
      kind: 'text',
      content: paragraph(`${head}<br>${proLine}${conLine}${bestFor}`, bodyFont),
      height: estimateHeight(plain, bodyFont) + 26,
      fontSize: bodyFont,
      gapAfter: 8,
    });
  }

  if (content.recommendation?.choice?.trim()) {
    const justification = content.recommendation.justification?.trim()
      ? ` — ${escapeHtml(content.recommendation.justification)}`
      : '';
    specs.push({
      kind: 'text',
      content: paragraph(
        `<strong>Recommendation: ${escapeHtml(content.recommendation.choice)}</strong>${justification}`,
        bodyFont,
        'border-left:3px solid #5b9bd5;padding-left:8px;',
      ),
      height:
        estimateHeight(
          `${content.recommendation.choice} ${content.recommendation.justification ?? ''}`,
          bodyFont,
        ) + 16,
      fontSize: bodyFont,
      gapAfter: 6,
    });
  }

  return layOut(fitIntoCanvas(specs));
}

export function renderFreeResponseToElements(
  outline: SceneOutline,
  content: GeneratedFreeResponseContent,
): GeneratedSlideData['elements'] {
  const specs: ElementSpec[] = [];
  const rubric = (content.rubric ?? []).filter((c) => c.criterion?.trim());
  const bodyFont = rubric.length > 3 ? 12 : 13;

  // The task itself, boxed.
  specs.push({
    kind: 'text',
    content: paragraph(
      `<strong>Your task</strong><br>${escapeHtml(content.prompt || outline.title)}`,
      bodyFont,
      'border-left:3px solid #5b9bd5;padding-left:8px;',
    ),
    height: estimateHeight(content.prompt || outline.title, bodyFont) + 22,
    fontSize: bodyFont,
    gapAfter: 8,
  });

  const guidance = (content.guidance ?? []).filter((g) => g?.trim());
  if (guidance.length > 0) {
    specs.push({
      kind: 'text',
      content: paragraph(
        `<em>Framing</em> — ${guidance.map((g) => escapeHtml(g)).join(' &nbsp;•&nbsp; ')}`,
        bodyFont,
        'color:#b8860b;',
      ),
      height: estimateHeight(guidance.join(' '), bodyFont) + 12,
      fontSize: bodyFont,
      gapAfter: 8,
    });
  }

  // The grading rubric.
  const weightStyle: Record<string, string> = {
    essential: 'color:#c0504d;',
    important: 'color:#b8860b;',
    bonus: 'color:#3f9950;',
  };
  specs.push({
    kind: 'text',
    content: paragraph('<strong>Grading rubric</strong>', bodyFont, 'color:#5b9bd5;'),
    height: 24,
    fontSize: bodyFont,
    gapAfter: 2,
  });
  rubric.forEach((criterion) => {
    const weight = String(criterion.weight);
    const label = weight.charAt(0).toUpperCase() + weight.slice(1);
    const text = `<span style="${weightStyle[weight] ?? ''}"><strong>[${label}]</strong></span> ${escapeHtml(criterion.criterion)}<br><em>Look for:</em> ${escapeHtml(criterion.lookFor ?? '')}`;
    const plain = `${criterion.criterion} ${criterion.lookFor ?? ''}`;
    specs.push({
      kind: 'text',
      content: paragraph(text, bodyFont),
      height: estimateHeight(plain, bodyFont) + 26,
      fontSize: bodyFont,
      gapAfter: 6,
    });
  });

  // A strong model answer, visually separated.
  if (content.sampleAnswer?.trim()) {
    specs.push({
      kind: 'text',
      content: paragraph(
        `<strong>Strong answer</strong> — ${escapeHtml(content.sampleAnswer)}`,
        bodyFont,
        'border-left:3px solid #3f9950;padding-left:8px;',
      ),
      height: estimateHeight(content.sampleAnswer, bodyFont) + 18,
      fontSize: bodyFont,
      gapAfter: 6,
    });
  }

  return layOut(fitIntoCanvas(specs));
}

