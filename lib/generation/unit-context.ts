/**
 * Prerequisite coherence threading (Phase 2 §15.5).
 *
 * Content generation for a scene receives a compact "what was taught so far
 * in this unit" block so scenes build on earlier material instead of
 * repeating it. Units are derived from the positional lesson ids assigned at
 * the outline stage (LESSONS_PER_UNIT lessons per unit), so no extra model
 * calls are needed.
 *
 * Pure functions only; no I/O.
 */

import { LESSONS_PER_UNIT } from '@/lib/constants/generation';
import type { SceneOutline } from '@/lib/types/generation';

/** Maximum serialized size of the unit-so-far block (defensive bound). */
export const MAX_UNIT_CONTEXT_CHARS = 4_000;

function parseLessonNumber(lessonId: string | undefined): number | null {
  if (!lessonId) return null;
  const match = /^lesson_(\d+)$/.exec(lessonId);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * Build the "what was taught so far" block for `outline` given the full
 * ordered deck. Includes only earlier scenes from the same unit (the
 * LESSONS_PER_UNIT lesson window around the outline's lesson), so a course's
 * later units never drag in unrelated earlier material. Empty string when
 * there is nothing to thread (first scene of the unit, or legacy decks
 * without lesson ids).
 */
export function buildUnitContext(
  outline: SceneOutline,
  allOutlines: SceneOutline[],
  options: { maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? MAX_UNIT_CONTEXT_CHARS;
  const lessonNumber = parseLessonNumber(outline.lessonId);
  if (lessonNumber === null) return '';

  const unitStart = Math.floor((lessonNumber - 1) / LESSONS_PER_UNIT) * LESSONS_PER_UNIT + 1;
  const unitEnd = unitStart + LESSONS_PER_UNIT - 1;

  const taught = allOutlines.filter((other) => {
    if (other.id === outline.id) return false;
    const otherLesson = parseLessonNumber(other.lessonId);
    return (
      otherLesson !== null &&
      otherLesson >= unitStart &&
      otherLesson <= unitEnd &&
      other.order < outline.order
    );
  });
  if (taught.length === 0) return '';

  const lines = taught
    .slice(-12)
    .map((o) => `- ${o.title}: ${(o.keyPoints ?? []).filter(Boolean).slice(0, 3).join('; ')}`);

  let text = [
    '## What Was Taught So Far (this unit)',
    'Material already covered earlier in this unit. Build on it and reference it; do not re-teach it:',
    ...lines,
  ].join('\n');

  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n… (truncated)`;
  }
  return text;
}
