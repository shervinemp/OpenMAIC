/**
 * App-side re-export of the unit review gate (LLM-as-judge per unit).
 *
 * The canonical implementation lives in @openmaic/generation (package
 * boundary: pure functions, no host-app imports). This shim keeps the
 * established `@/lib/generation/unit-review` import surface working.
 */
export {
  buildUnitReviewSummary,
  summarizeUnitReviewFindings,
  validateUnitReviewVerdict,
} from '@openmaic/generation';
export type { UnitReviewVerdict } from '@openmaic/generation';
