/**
 * App-side re-export of the course blueprint contract.
 *
 * The canonical implementation lives in @openmaic/generation (package
 * boundary: pure functions, no host-app imports). This shim keeps the
 * established `@/lib/generation/blueprint` import surface for the outline
 * route and classroom generation working.
 */
export {
  assignLessonIds,
  buildCourseBlueprint,
  clampDurationMinutes,
  deriveCourseContract,
  inferCourseType,
  parseDurationFromText,
  renderCourseContract,
  splitIntoLessons,
  summarizeBlueprintValidation,
  validateBlueprint,
  MAX_BLUEPRINT_ATTEMPTS,
} from '@openmaic/generation';
export type {
  BlueprintValidationOptions,
  BlueprintValidationResult,
  CourseBlueprint,
  CourseContract,
  CourseType,
  LessonBlueprint,
  ParsedOutlineResponse,
} from '@openmaic/generation';
