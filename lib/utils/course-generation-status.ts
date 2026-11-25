/**
 * The home-page card's single generation control, derived from the course
 * document and the backend job snapshot. Pure and structural on purpose: the
 * card, the library list and tests can all use it without importing stores.
 */

export type CourseGenerationAction = 'pause' | 'resume' | 'regenerate' | 'delete';

export interface CourseGenerationStatus {
  action: CourseGenerationAction;
}

export interface CourseGenerationCourse {
  sceneCount: number;
  outlineCount?: number;
  generationComplete?: boolean;
}

export function deriveCourseGenerationStatus({
  classroom,
  active,
  parked,
}: {
  classroom: CourseGenerationCourse;
  active: boolean;
  parked: boolean;
}): CourseGenerationStatus | null {
  // A live run (server job or browser loop) can always be paused. If the user
  // wants it gone instead, the explicit delete control removes the course.
  if (active || parked) return { action: 'pause' };

  // A course with no committed scenes has nothing to teach. With outlines it
  // can be regenerated; without them the only useful action is deleting it.
  if (!classroom.sceneCount) {
    if ((classroom.outlineCount ?? 0) > 0) return { action: 'regenerate' };
    return { action: 'delete' };
  }

  if (
    classroom.generationComplete === false &&
    (classroom.outlineCount ?? 0) > classroom.sceneCount
  ) {
    return { action: 'resume' };
  }
  return null;
}
