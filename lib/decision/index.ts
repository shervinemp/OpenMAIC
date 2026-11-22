/**
 * Optional typed decision layer.
 *
 * Server-only: the `chat` adapter resolves models and calls `callLLM`.
 * Nothing here is imported by a client component.
 */

export * from './types';
export { decisionConfigFromRequest, DECISION_HEADERS } from './request-config';
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
export { buildClaimDecisionRequest, createClaimReviewHook } from './sites/claim-check';
export {
  buildQuizDecisionRequest,
  compareQuizGrades,
  quizDecisionInputChars,
  quizGradeFromResult,
  type QuizDecisionInput,
} from './sites/quiz-grade';
export {
  mergeDecisionTelemetry,
  readDecisionTelemetry,
  readShadowAgreement,
  resetDecisionTelemetryForTests,
  snapshotDecisionTelemetry,
  type DecisionTelemetryCounter,
  type DecisionTelemetrySnapshot,
  type ShadowAgreementRow,
} from './telemetry';
export {
  decisionTelemetryFile,
  flushDecisionTelemetry,
  loadDecisionTelemetryFromDisk,
  scheduleDecisionTelemetryFlush,
} from './telemetry-file';
export {
  probeDecisionSites,
  type DecisionProbeStatus,
  type DecisionSiteProbe,
  type ProbeDecisionSitesOptions,
} from './probe';
export {
  createTypedHttpProvider,
  MAX_DECISION_RESPONSE_BYTES,
  TypedDecisionResponseError,
  type TypedHttpProviderOptions,
} from './providers/laya';
