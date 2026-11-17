import { describe, expect, it } from 'vitest';

import { masteryByConcept } from '@/lib/learning/mastery';
import { planLearningRoute } from '@/lib/learning/route';
import { routeLessonsFromScenes } from '@/lib/learning/route-scenes';
import type { LearningEvidence } from '@/lib/learning/types';
import type { ExamSpec } from '@/lib/types/exam';
import type { Scene } from '@/lib/types/stage';

function scene(overrides: Record<string, unknown>): Scene {
  return {
    stageId: 'stage-1',
    title: 'Untitled',
    order: 0,
    ...overrides,
  } as unknown as Scene;
}

function teaching(id: string, outlineId: string, order: number): Scene {
  return scene({
    id,
    title: `Lesson ${id}`,
    order,
    type: 'slide',
    outlineId,
    content: { type: 'slide' },
  });
}

function quiz(id: string, order: number, questions: unknown[]): Scene {
  return scene({
    id,
    title: `Quiz ${id}`,
    order,
    type: 'quiz',
    content: { type: 'quiz', questions },
  });
}

function activity(id: string, order: number, concepts: unknown): Scene {
  return scene({
    id,
    title: `Lab ${id}`,
    order,
    type: 'activity',
    content: { type: 'activity', concepts },
  });
}

function exam(mcQuestions: unknown[], frQuestions: unknown[] = []): ExamSpec {
  return {
    kind: 'midterm',
    title: 'Midterm',
    coverage: 'Units 1-2',
    unitRange: { from: 0, to: 1 },
    mcQuestions,
    frQuestions,
    generatedAt: 1,
  } as unknown as ExamSpec;
}

function evidence(conceptId: string, score: number, index: number): LearningEvidence {
  return {
    id: `evt-${index}`,
    learnerKey: 'learner-1',
    stageId: 'stage-1',
    itemId: `q${index}`,
    conceptIds: [conceptId],
    source: 'quiz',
    score,
    outcome: 'graded',
    recordedAt: index,
  };
}

describe('route lessons from scenes', () => {
  it("maps quiz concepts to the teaching scene's outline", () => {
    const lessons = routeLessonsFromScenes([
      teaching('lesson-1', 'outline-1', 0),
      quiz('quiz-1', 1, [
        { id: 'q1', concepts: ['Recursion', 'base case'], remediationOutlineId: 'outline-1' },
        { id: 'q2', concepts: ['recursion.'], remediationOutlineId: 'outline-1' },
      ]),
    ]);

    expect(lessons).toEqual([
      {
        sceneId: 'lesson-1',
        title: 'Lesson lesson-1',
        order: 0,
        conceptIds: ['base case', 'recursion'],
      },
    ]);
  });

  it('gives an activity its own scene-level concepts', () => {
    const lessons = routeLessonsFromScenes([
      activity('lab-1', 0, ['SQL Joins', 'Indexes']),
      teaching('lesson-1', 'outline-1', 1),
    ]);

    expect(lessons).toEqual([
      {
        sceneId: 'lab-1',
        title: 'Lab lab-1',
        order: 0,
        conceptIds: ['indexes', 'sql joins'],
      },
    ]);
  });

  it('merges exam pool concepts into the linked lesson', () => {
    const lessons = routeLessonsFromScenes([teaching('lesson-1', 'outline-1', 0)], {
      midterm: exam(
        [{ id: 'm1', concepts: ['recursion'], remediationOutlineId: 'outline-1' }],
        [{ id: 'f1', concepts: ['base case'], remediationOutlineId: 'outline-1' }],
      ),
    });

    expect(lessons).toEqual([
      {
        sceneId: 'lesson-1',
        title: 'Lesson lesson-1',
        order: 0,
        conceptIds: ['base case', 'recursion'],
      },
    ]);
  });

  it('deduplicates concepts across quiz and exam items', () => {
    const lessons = routeLessonsFromScenes(
      [
        teaching('lesson-1', 'outline-1', 0),
        quiz('quiz-1', 1, [
          { id: 'q1', concepts: ['Recursion'], remediationOutlineId: 'outline-1' },
        ]),
      ],
      {
        midterm: exam([{ id: 'm1', concepts: ['recursion.'], remediationOutlineId: 'outline-1' }]),
      },
    );

    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.conceptIds).toEqual(['recursion']);
  });

  it('drops links to outlines that have no live scene', () => {
    const lessons = routeLessonsFromScenes([
      teaching('lesson-1', 'outline-1', 0),
      quiz('quiz-1', 1, [
        { id: 'q1', concepts: ['recursion'], remediationOutlineId: 'deleted-outline' },
        { id: 'q2', concepts: ['loops'], remediationOutlineId: 'outline-1' },
      ]),
    ]);

    expect(lessons).toEqual([
      {
        sceneId: 'lesson-1',
        title: 'Lesson lesson-1',
        order: 0,
        conceptIds: ['loops'],
      },
    ]);
  });

  it('never targets a scene without an outline id', () => {
    const lessons = routeLessonsFromScenes([
      scene({ id: 'inserted', title: 'Inserted slide', order: 0, type: 'slide', content: {} }),
      quiz('quiz-1', 1, [{ id: 'q1', concepts: ['recursion'], remediationOutlineId: 'inserted' }]),
    ]);

    expect(lessons).toEqual([]);
  });

  it('normalizes sloppy activity tags and drops format-only ones', () => {
    const lessons = routeLessonsFromScenes([
      activity('lab-1', 0, ['  Recursion.  ', 'quiz', 'RECURSION', '- base case']),
    ]);

    expect(lessons).toEqual([
      {
        sceneId: 'lab-1',
        title: 'Lab lab-1',
        order: 0,
        conceptIds: ['base case', 'recursion'],
      },
    ]);
  });

  it('ignores untagged items and empty exam slots', () => {
    const lessons = routeLessonsFromScenes(
      [
        teaching('lesson-1', 'outline-1', 0),
        quiz('quiz-1', 1, [
          { id: 'q1', concepts: [] },
          { id: 'q2', concepts: ['recursion'] },
        ]),
      ],
      { midterm: undefined },
    );

    expect(lessons).toEqual([]);
  });

  it('keeps the scene order and title as the lesson identity', () => {
    const lessons = routeLessonsFromScenes([
      activity('lab-1', 7, ['loops']),
      activity('lab-2', 3, ['recursion']),
    ]);

    expect(lessons).toEqual([
      { sceneId: 'lab-1', title: 'Lab lab-1', order: 7, conceptIds: ['loops'] },
      { sceneId: 'lab-2', title: 'Lab lab-2', order: 3, conceptIds: ['recursion'] },
    ]);
  });

  it('returns no lessons for an untagged course', () => {
    expect(
      routeLessonsFromScenes([
        teaching('lesson-1', 'outline-1', 0),
        quiz('quiz-1', 1, [{ id: 'q1', concepts: ['recursion'] }]),
      ]),
    ).toEqual([]);
  });

  it('connects scene tags to mastery evidence end to end', () => {
    const lessons = routeLessonsFromScenes([
      teaching('lesson-1', 'outline-1', 0),
      quiz('quiz-1', 1, [{ id: 'q1', concepts: ['Recursion'], remediationOutlineId: 'outline-1' }]),
    ]);
    const mastery = masteryByConcept([evidence('recursion', 0, 0), evidence('recursion', 0, 1)]);

    expect(planLearningRoute({ lessons, mastery })).toEqual({
      kind: 'review',
      lesson: {
        sceneId: 'lesson-1',
        title: 'Lesson lesson-1',
        order: 0,
        conceptIds: ['recursion'],
      },
      conceptIds: ['recursion'],
    });
  });
});
