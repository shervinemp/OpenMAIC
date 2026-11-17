import { describe, expect, it } from 'vitest';
import { validateScene } from '@openmaic/dsl';
import {
  createBlankActivityScene,
  createBlankEditableScene,
  insertSceneAtIndex,
} from '@/lib/edit/scene-defaults';

describe('createBlankActivityScene', () => {
  it('builds a structurally valid code lab', () => {
    const scene = createBlankActivityScene('stage-1', 'Lab', 3);
    expect(scene).toMatchObject({
      type: 'activity',
      stageId: 'stage-1',
      title: 'Lab',
      order: 3,
    });
    expect(scene.content).toMatchObject({
      type: 'activity',
      kind: 'code',
      language: 'python',
      entryFile: 'main.py',
    });
    expect(validateScene(scene)).toEqual({ valid: true });
  });

  it('is reachable through the rail scene factory', () => {
    const scene = createBlankEditableScene('activity', 'stage-1', 'Lab', 1);
    expect(scene.type).toBe('activity');
    expect(validateScene(scene)).toEqual({ valid: true });
  });

  it('keeps quiz and slide creation unchanged', () => {
    expect(createBlankEditableScene('quiz', 's', 'Quiz', 1).type).toBe('quiz');
    expect(createBlankEditableScene('slide', 's', 'Slide', 1).type).toBe('slide');
  });
});

describe('insertSceneAtIndex', () => {
  it('rebalances order after inserting a lab', () => {
    const a = createBlankEditableScene('slide', 's', 'A', 1);
    const b = createBlankEditableScene('slide', 's', 'B', 2);
    const lab = createBlankEditableScene('activity', 's', 'Lab', 2);
    const next = insertSceneAtIndex([a, b], lab, 1);
    expect(next.map((scene) => [scene.title, scene.order])).toEqual([
      ['A', 1],
      ['Lab', 2],
      ['B', 3],
    ]);
  });
});
