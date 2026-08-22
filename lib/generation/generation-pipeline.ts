/**
 * App-side re-export of the scene generation pipeline.
 *
 * The canonical implementations live in @openmaic/generation (package
 * boundary: pure functions, no host-app imports). This shim keeps the
 * established `@/lib/generation/generation-pipeline` import surface working
 * for the scene routes, the agent tools, and their tests.
 */
export {
  applyOutlineFallbacks,
  buildCompleteScene,
  buildVisionUserContent,
  buildOutlinePrompt,
  changeOutlineType,
  formatImageDescription,
  formatImagePlaceholder,
  formatTeacherPersonaForPrompt,
  generateSceneActions,
  generateSceneContent,
  generateWidgetContent,
  resolveImageIds,
  uniquifyMediaElementIds,
  parseJsonResponse,
  extractInteractiveElements,
  extractWidgetConfig,
  buildCourseContext,
} from '@openmaic/generation';
export type {
  AgentInfo,
  GeneratedSlideData,
  SceneGenerationContext,
  AICallFn,
} from '@openmaic/generation';
