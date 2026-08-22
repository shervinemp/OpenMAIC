/**
 * App-side re-export of the content depth contract.
 *
 * The canonical implementation lives in @openmaic/generation (package
 * boundary: pure functions, no host-app imports). This shim keeps the
 * established `@/lib/generation/content-depth` import surface working.
 */
export {
  renderDerivationToElements,
  renderExerciseToElements,
  renderGlossaryToElements,
  renderComparisonToElements,
  renderDataReadingToElements,
  renderReadingToElements,
  renderTradeoffsToElements,
} from '@openmaic/generation';
