import { describe, expect, it } from 'vitest';

import { deriveCourseGenerationStatus } from '@/lib/utils/course-generation-status';

describe('deriveCourseGenerationStatus', () => {
  it('pauses a live server job or a parked browser loop', () => {
    expect(
      deriveCourseGenerationStatus({
        classroom: { sceneCount: 0, outlineCount: 0, generationComplete: false },
        active: true,
        parked: false,
      }),
    ).toEqual({ action: 'pause' });
    expect(
      deriveCourseGenerationStatus({
        classroom: { sceneCount: 10, outlineCount: 100, generationComplete: false },
        active: false,
        parked: true,
      }),
    ).toEqual({ action: 'pause' });
  });

  it('pauses an outline pass that has not produced a document yet', () => {
    expect(
      deriveCourseGenerationStatus({
        classroom: { sceneCount: 0, outlineCount: 0, generationActive: true },
        active: false,
        parked: false,
      }),
    ).toEqual({ action: 'pause' });
  });

  it('regenerates an empty course that still has outlines', () => {
    expect(
      deriveCourseGenerationStatus({
        classroom: { sceneCount: 0, outlineCount: 600, generationComplete: false },
        active: false,
        parked: false,
      }),
    ).toEqual({ action: 'regenerate' });
  });

  it('offers deletion for a course with no outlines and no content', () => {
    for (const generationComplete of [false, undefined]) {
      expect(
        deriveCourseGenerationStatus({
          classroom: { sceneCount: 0, outlineCount: 0, generationComplete },
          active: false,
          parked: false,
        }),
      ).toEqual({ action: 'delete' });
    }
  });

  it('resumes an incomplete course that has some content', () => {
    expect(
      deriveCourseGenerationStatus({
        classroom: { sceneCount: 83, outlineCount: 600, generationComplete: false },
        active: false,
        parked: false,
      }),
    ).toEqual({ action: 'resume' });
  });

  it('shows no control for a complete course', () => {
    expect(
      deriveCourseGenerationStatus({
        classroom: { sceneCount: 600, outlineCount: 600, generationComplete: true },
        active: false,
        parked: false,
      }),
    ).toBeNull();
  });
});
