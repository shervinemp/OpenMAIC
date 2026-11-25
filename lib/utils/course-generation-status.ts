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
  generationActive?: boolean;
  updatedAt?: number;
}

/** An outline flag left behind by a crashed helper must not offer a dead Pause. */
const GENERATION_ACTIVE_TTL = 6 * 60 * 60_000;

export function deriveCourseGenerationStatus({
  classroom,
  active,
  parked,
}: {
  classroom: CourseGenerationCourse;
  active: boolean;
  parked: boolean;
}): CourseGenerationStatus | null {
  // A live run (server job, browser loop, or an outline pass that has not
  // committed a document yet) can always be paused. If the user wants it gone
  // instead, the explicit delete control removes the course.
  const outlineRunning =
    classroom.generationActive === true &&
    (!classroom.updatedAt || Date.now() - classroom.updatedAt < GENERATION_ACTIVE_TTL);
  if (active || parked || outlineRunning) return { action: 'pause' };

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
