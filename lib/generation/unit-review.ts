/**
 * Unit review gate (Phase 2 §15.5).
 *
 * After a unit's outline deck passes the structural blueprint contract, an
 * LLM-as-judge pass evaluates it against the unit's own objectives (coverage,
 * depth, sequencing). A failing verdict feeds the unit's bounded corrective
 * loop — the same retry budget as the structural contract — so a unit is
 * never accepted if its scenes do not actually teach its objectives.
 *
 * Pure functions only; no I/O. The LLM plumbing lives in the outline route,
 * which owns the bounded loop.
 */

import type { SceneOutline, UnitBlueprint } from '@/lib/types/generation';

/** Maximum serialized size of a unit's outline summary (defensive bound). */
const MAX_SUMMARY_CHARS = 12_000;

export interface UnitReviewVerdict {
  /** The judge accepts the unit's deck against its objectives. */
  adequate: boolean;
  /** Concrete, actionable findings (empty when adequate). */
  findings: string[];
}

/**
 * Compact, prompt-safe serialization of a unit's outlines for the judge:
 * one line per scene (title, description, key points), truncated defensively
 * so a degenerate/hallucinated unit cannot blow up the judge prompt.
 */
export function buildUnitReviewSummary(
  unit: Pick<UnitBlueprint, 'title' | 'objectives' | 'lessons'>,
  outlines: SceneOutline[],
): string {
  const lessonTitles = unit.lessons.map((lesson, index) => `  ${index + 1}. ${lesson.title}`).join('\n');
  const sceneLines = outlines.map((outline) => {
    const keyPoints = (outline.keyPoints ?? []).filter(Boolean).slice(0, 5).join('; ');
    return `${outline.order}. [${outline.type}] ${outline.title} — ${outline.description}${
      keyPoints ? ` | Key points: ${keyPoints}` : ''
    }`;
  });

  let body = [
    `Unit: ${unit.title}`,
    `Objectives: ${(unit.objectives ?? []).join('; ')}`,
    'Lessons:',
    lessonTitles,
    'Scenes:',
    ...sceneLines,
  ].join('\n');

  if (body.length > MAX_SUMMARY_CHARS) {
    body = `${body.slice(0, MAX_SUMMARY_CHARS)}\n… (truncated)`;
  }
  return body;
}

/**
 * Validate the judge's parsed verdict. Findings are required when the
 * verdict is inadequate — a rejection without concrete feedback cannot
 * drive the corrective loop.
 */
export function validateUnitReviewVerdict(
  parsed: unknown,
): { verdict: UnitReviewVerdict | null; errors: string[] } {
  const errors: string[] = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { verdict: null, errors: ['verdict must be a JSON object'] };
  }
  const obj = parsed as Record<string, unknown>;

  const adequate = obj.adequate;
  if (typeof adequate !== 'boolean') {
    errors.push('verdict is missing the "adequate" boolean');
  }

  const findings = obj.findings;
  const findingsList =
    Array.isArray(findings) && findings.every((f) => typeof f === 'string') ? findings : [];
  if (!Array.isArray(findings)) {
    errors.push('verdict is missing the "findings" string array');
  }
  if (adequate === false && findingsList.length === 0) {
    errors.push('an inadequate verdict must carry at least one concrete finding');
  }
  if (adequate === true && findingsList.length > 0) {
    // Tolerated but noisy: an adequate verdict has nothing to fix. Strip them.
    return { verdict: { adequate: true, findings: [] }, errors };
  }

  if (errors.length > 0) return { verdict: null, errors };
  return {
    verdict: {
      adequate: adequate as boolean,
      findings: findingsList.filter((f) => f.trim().length > 0),
    },
    errors: [],
  };
}

/**
 * Convert a failing verdict into corrective feedback appended to the unit's
 * next outline-generation attempt.
 */
export function summarizeUnitReviewFindings(verdict: UnitReviewVerdict): string {
  return [
    'The unit review gate REJECTED this unit: its scenes do not adequately teach the unit objectives.',
    ...verdict.findings.map((finding) => `- ${finding}`),
    'Revise the unit outlines so every objective is taught by concrete scenes, and return the corrected JSON.',
  ].join('\n');
}
