/**
 * App-side re-export of the outline type helpers.
 *
 * The canonical implementation lives in @openmaic/generation (package
 * boundary: pure functions, no host-app imports). This shim keeps the
 * established `@/lib/generation/outline-type` import surface working.
 */
export { changeOutlineType, isSlideLikeOutline } from '@openmaic/generation';
export type { SceneType } from '@openmaic/generation';
