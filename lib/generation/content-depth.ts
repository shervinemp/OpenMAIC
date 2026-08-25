/**
 * App-side re-export of the content depth contract.
 *
 * The canonical implementation lives in @openmaic/generation (package
 * boundary: pure functions, no host-app imports). This shim keeps the
 * established `@/lib/generation/content-depth` import surface working.
 */
export {
  extractSlideTexts,
  isCaptionText,
  isIntroSummaryOutline,
  isSubstantiveText,
  recordSceneDepthReport,
  recordSceneDepthSummary,
  summarizeDepthFindings,
  takeSceneDepthReport,
  takeSceneDepthSummary,
  validateDerivationDepth,
  validateExerciseDepth,
  validateFreeResponseDepth,
  validateGlossaryDepth,
  validateComparisonDepth,
  validateDataReadingDepth,
  validateQuizDepth,
  validateReadingDepth,
  validateTradeoffsDepth,
  validateSlideDepth,
} from '@openmaic/generation';
export type {
  DepthReport,
  SceneDepthSummary,
  SlideDepthOptions,
} from '@openmaic/generation';
