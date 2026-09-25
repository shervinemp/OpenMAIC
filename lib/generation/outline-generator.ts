/**
 * App-side re-export of the outline generation stage.
 *
 * The canonical implementation lives in @openmaic/generation (package
 * boundary: pure functions, no host-app imports) — including the blueprint
 * contract loop. This shim keeps the established
 * `@/lib/generation/outline-generator` import surface working.
 */
export {
  DEFAULT_LANGUAGE_DIRECTIVE,
  applyOutlineFallbacks,
  buildOutlinePrompt,
  generateSceneOutlinesFromRequirements,
  sanitizeProceduralSkillOutline,
} from '@openmaic/generation';
export type {
  OutlineFallbackOptions,
  OutlineGenerationOptions,
  OutlinePromptContext,
} from '@openmaic/generation';
