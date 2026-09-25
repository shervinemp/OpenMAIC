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
}

export interface ExamSpec {
  kind: ExamKind;
  title: string;
  /** Human-readable coverage, e.g. "Units 1-3". */
  coverage: string;
  /** Covered unit indexes (0-based into blueprint.units). */
  unitRange: { from: number; to: number };
  mcQuestions: ExamChoiceQuestion[];
  frQuestions: ExamFreeResponse[];
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
  /** Picked option value per MC question ("A"). */
  mcAnswers: Record<string, string>;
  frAnswers: Record<string, string>;
  /** Auto-graded MC results keyed by question id. */
  mcResults: Record<string, { correct: boolean; earned: number }>;
  frGrades: ExamFrGrade[];
  /** Fraction 0-1 over the whole exam, once fully graded. */
  scorePct: number | null;
  submittedAt: number;
  gradedAt?: number;
}
