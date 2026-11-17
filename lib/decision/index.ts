/**
 * Optional typed decision layer.
 *
 * Server-only: the `chat` adapter resolves models and calls `callLLM`.
 * Nothing here is imported by a client component.
 */

export * from './types';
export {
  decisionModelsEnabled,
  getDecisionSiteConfig,
  loadDecisionConfigs,
  parseDecisionRoutes,
  resetDecisionConfigForTests,
} from './config';
export {
  runDecisionSite,
  type DecisionRunDeps,
  type DecisionRunInput,
  type DecisionRunOutcome,
} from './router';
export {
  createDecisionQuizVerifier,
  type DecisionQuizVerifierOptions,
} from './sites/quiz-verifier';
export {
  buildExamDecisionRequest,
  compareExamGrades,
  examDecisionInputChars,
  examGradeFromResult,
  type ExamDecisionInput,
} from './sites/exam-grading';
export {
  buildQuizDecisionRequest,
  compareQuizGrades,
  quizDecisionInputChars,
  quizGradeFromResult,
  type QuizDecisionInput,
} from './sites/quiz-grade';
export { readDecisionTelemetry, resetDecisionTelemetryForTests } from './telemetry';
