/**
 * Semester exam types: midterm / final exams as a non-scene artifact.
 *
 * An exam is generated from the course blueprint (unit/lesson objectives and
 * key points), not from generated scene content, so it is available as soon
 * as the outline exists. The persisted artifacts ride inside the opaque
 * `AppDocumentOutline` snapshot (`exams` / `examAttempts`).
 */

import type { RubricCriterion } from './generation';
import type { QuizOption } from '@openmaic/dsl';

export type ExamKind = 'midterm' | 'final';

/** A substantial single-answer MC question generated for the exam. */
export interface ExamChoiceQuestion {
  id: string;
  /** Scenario/application stem, not a bare definition recall. */
  question: string;
  options: QuizOption[];
  /** Correct option value(s); exams use single-answer ("A"). */
  answer: string[];
  /** Shown after grading. */
  analysis: string;
  points: number;
  /** 1-4 normalized concept tags this question measures; absent on legacy specs. */
  concepts?: string[];
}

/** A constructed-response question graded per rubric by the LLM. */
export interface ExamFreeResponse {
  id: string;
  prompt: string;
  guidance?: string[];
  rubric: RubricCriterion[];
  sampleAnswer: string;
  maxPoints: number;
  /** Grading guidance fed to the grader in addition to the rubric. */
  commentPrompt?: string;
  /** 1-4 normalized concept tags this question measures; absent on legacy specs. */
  concepts?: string[];
}

/**
 * How one attempt is drawn from the generated question pool. The pool itself
 * lives in `mcQuestions` / `frQuestions`; a form is a seeded subset (and, for
 * MC, a seeded option order) so two learners — or two retakes — do not see the
 * same paper. Counts are capped by the pool size when an exam is underfilled.
 */
export interface ExamFormConfig {
  mcCount: number;
  frCount: number;
}

/**
 * Wall-clock budget per section. A missing section budget means that section
 * is untimed; generation always writes both, and the UI only shows a timer
 * when one is present.
 */
export interface ExamSectionTiming {
  mcSec?: number;
  frSec?: number;
}

export interface ExamSpec {
  kind: ExamKind;
  title: string;
  /** Human-readable coverage, e.g. "Units 1-3". */
  coverage: string;
  /** Covered unit indexes (0-based into blueprint.units). */
  unitRange: { from: number; to: number };
  /**
   * The MC question POOL. New specs draw a seeded form from it; legacy specs
   * without `formConfig` use every question in this order.
   */
  mcQuestions: ExamChoiceQuestion[];
  /** The FR question pool; same rule as `mcQuestions`. */
  frQuestions: ExamFreeResponse[];
  /** Per-attempt form size. Omitted for pre-variant specs. */
  formConfig?: ExamFormConfig;
  /** Per-section time budgets, in seconds. */
  timing?: ExamSectionTiming;
  generatedAt: number;
}

/** Per-question LLM grade for one free-response answer. */
export interface ExamFrGrade {
  questionId: string;
  score: number;
  maxPoints: number;
  comment: string;
  /** Per-criterion verdict when the grader returned them. */
  criteria?: Array<{
    id: string;
    met: boolean;
    comment: string;
  }>;
}

/** A student's submitted exam attempt with grades. */
export interface ExamAttempt {
  id: string;
  kind: ExamKind;
  /**
   * Seed that deterministically selects this attempt's questions and MC option
   * order. Absent on attempts submitted before variants shipped; those used
   * the whole spec in stored order.
   */
  variantSeed?: string;
  /**
   * `ExamSpec.generatedAt` this attempt was drawn from. Guards learning
   * evidence against a regenerated pool: the same seed resolves to different
   * questions after regeneration. Absent on legacy attempts, which are not
   * backfilled.
   */
  specGeneratedAt?: number;
  /** Picked option value per MC question ("A"). */
  mcAnswers: Record<string, string>;
  frAnswers: Record<string, string>;
  /** Auto-graded MC results keyed by question id. */
  mcResults: Record<string, { correct: boolean; earned: number }>;
  frGrades: ExamFrGrade[];
  /** Fraction 0-1 over the whole exam, once fully graded. */
  scorePct: number | null;
  /** Seconds actually spent per section, when the section was timed. */
  sectionSeconds?: { mc?: number; fr?: number };
  /** True when the attempt was submitted by the section timer, not the learner. */
  timedOut?: boolean;
  submittedAt: number;
  gradedAt?: number;
}
