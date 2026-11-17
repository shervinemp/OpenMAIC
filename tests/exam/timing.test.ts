import { describe, expect, it } from 'vitest';
import type { ExamSpec } from '@/lib/types/exam';
import {
  DEFAULT_EXAM_TIMING,
  effectiveExamTiming,
  formatExamClock,
  formatExamMinutes,
  secondsRemaining,
  sectionBudgetSec,
} from '@/lib/exam/timing';

const spec = (timing?: ExamSpec['timing']): ExamSpec => ({
  kind: 'midterm',
  title: 'Midterm',
  coverage: 'Units 1-2',
  unitRange: { from: 0, to: 1 },
  mcQuestions: [],
  frQuestions: [],
  timing,
  generatedAt: 1,
});

describe('exam section timing', () => {
  it('drops malformed budgets instead of auto-submitting instantly', () => {
    expect(effectiveExamTiming(spec({ mcSec: Number.NaN, frSec: -20 }))).toEqual({
      mcSec: undefined,
      frSec: undefined,
    });
    expect(effectiveExamTiming(spec({ mcSec: 0, frSec: 90 }))).toEqual({
      mcSec: undefined,
      frSec: 90,
    });
  });

  it('treats a missing timing block as untimed', () => {
    expect(effectiveExamTiming(spec())).toEqual({ mcSec: undefined, frSec: undefined });
    expect(sectionBudgetSec(spec(), 'mc')).toBeNull();
    expect(sectionBudgetSec(spec({ mcSec: 1200, frSec: 1800 }), 'fr')).toBe(1800);
  });

  it('writes realistic defaults for both exam kinds', () => {
    expect(DEFAULT_EXAM_TIMING.midterm).toEqual({ mcSec: 1500, frSec: 2100 });
    expect(DEFAULT_EXAM_TIMING.final).toEqual({ mcSec: 2100, frSec: 3000 });
  });

  it('formats sub-hour and hour-plus clocks', () => {
    expect(formatExamClock(1500)).toBe('25:00');
    expect(formatExamClock(59)).toBe('00:59');
    expect(formatExamClock(0)).toBe('00:00');
    expect(formatExamClock(3661)).toBe('1:01:01');
    expect(formatExamMinutes(1500)).toBe('25 min');
  });

  it('ceil-rounds the remaining time so a fresh section reads the full budget', () => {
    expect(secondsRemaining(60_000, 0)).toBe(60);
    expect(secondsRemaining(60_000, 1)).toBe(60);
    expect(secondsRemaining(60_000, 60_000)).toBe(0);
    expect(secondsRemaining(60_000, 90_000)).toBe(0);
  });
});
