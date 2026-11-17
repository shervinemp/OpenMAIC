/**
 * Pure timing helpers for exam sections.
 *
 * The UI owns the clock (a deadline timestamp plus a one-second tick), but the
 * budget parsing and formatting live here so they can be tested without a
 * DOM and reused by review/analytics.
 */

import type { ExamKind, ExamSectionTiming, ExamSpec } from '@/lib/types/exam';

export type ExamSection = 'mc' | 'fr';

/** Section budgets written into every generated exam. */
export const DEFAULT_EXAM_TIMING: Record<ExamKind, { mcSec: number; frSec: number }> = {
  midterm: { mcSec: 25 * 60, frSec: 35 * 60 },
  final: { mcSec: 35 * 60, frSec: 50 * 60 },
};

/** Four hours is the hardest bound a single section may claim. */
const MAX_SECTION_SEC = 4 * 60 * 60;

function normalizeSeconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(MAX_SECTION_SEC, Math.round(value));
}

/**
 * Defensive timing read: hand-edited or legacy documents may carry nonsense,
 * and a bad budget must degrade to "untimed" rather than a zero-second section
 * that auto-submits instantly.
 */
export function effectiveExamTiming(spec: ExamSpec): ExamSectionTiming {
  return {
    mcSec: normalizeSeconds(spec.timing?.mcSec),
    frSec: normalizeSeconds(spec.timing?.frSec),
  };
}

export function sectionBudgetSec(spec: ExamSpec, section: ExamSection): number | null {
  const timing = effectiveExamTiming(spec);
  return section === 'mc' ? (timing.mcSec ?? null) : (timing.frSec ?? null);
}

/** `mm:ss`, or `h:mm:ss` once the budget crosses an hour. */
export function formatExamClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Compact human label for the exam list ("25 min"). */
export function formatExamMinutes(totalSeconds: number): string {
  return `${Math.max(1, Math.round(totalSeconds / 60))} min`;
}

/**
 * Seconds left on a deadline. The UI ceil-rounds so a fresh 25-minute section
 * reads 25:00, not 24:59.
 */
export function secondsRemaining(deadlineMs: number, nowMs = Date.now()): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}
