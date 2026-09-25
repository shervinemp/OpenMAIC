import { describe, expect, test } from 'vitest';
import {
  buildLessonGroupsFromBlueprint,
  flattenBlueprintOutlines,
  canonicalizeOutlineV2,
} from '@/lib/document-store/canonicalize';
import { legacyBlueprintFromOutlines } from '@/lib/generation/blueprint';
import { validateBlueprint } from '@/lib/generation/blueprint';
import type { StageOutlinesRecord } from '@/lib/utils/database';
import type { SceneOutline } from '@/lib/types/generation';

function makeOutlines(count: number): SceneOutline[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `scene_${i + 1}`,
    type: 'slide',
    title: `Scene ${i + 1}`,
    description: `Describe scene ${i + 1}.`,
    keyPoints: [`Key ${i + 1}`],
    order: i + 1,
  }));
}

function makeRecord(outlines: SceneOutline[], generationComplete = false): StageOutlinesRecord {
  return {
    stageId: 'stage-1',
    outlines,
    generationComplete,
    createdAt: 100,
    updatedAt: 200,
  };
}

describe('legacyBlueprintFromOutlines', () => {
  test('wraps a flat deck in a single-lesson blueprint with lessonIds', () => {
    const blueprint = legacyBlueprintFromOutlines(makeOutlines(3), 'Legacy Deck');
    expect(blueprint.lessonCount).toBe(1);
    expect(blueprint.lessons[0].sceneTarget).toBe(3);
    expect(blueprint.lessons[0].outlines.every((o) => o.lessonId === 'lesson_1')).toBe(true);
    expect(blueprint.title).toBe('Legacy Deck');
    expect(blueprint.objectives.length).toBeGreaterThanOrEqual(2);
  });

  test('legacy decks pass validation only in legacy mode (counts are exempt)', () => {
    const blueprint = legacyBlueprintFromOutlines(makeOutlines(2), 'Tiny Deck');
    expect(validateBlueprint(blueprint, { legacy: true }).valid).toBe(true);
    expect(validateBlueprint(blueprint).valid).toBe(false);
  });
});

describe('buildLessonGroupsFromBlueprint', () => {
  test('creates one job per outline with all phases pending, referencing blueprint ids', () => {
    const blueprint = legacyBlueprintFromOutlines(makeOutlines(5), 'Deck');
    const groups = buildLessonGroupsFromBlueprint(blueprint);
    expect(groups).toHaveLength(1);
    expect(groups[0].jobs).toHaveLength(5);
    expect(groups[0].jobs[0].outlineId).toBe('scene_1');
    for (const job of groups[0].jobs) {
      for (const phase of Object.values(job.phases)) {
        expect(phase.status).toBe('pending');
      }
    }
  });

  test('flattenBlueprintOutlines returns the compat projection in order', () => {
    const blueprint = legacyBlueprintFromOutlines(makeOutlines(4), 'Deck');
    const flat = flattenBlueprintOutlines(blueprint);
    expect(flat.map((o) => o.order)).toEqual([1, 2, 3, 4]);
  });
});

describe('canonicalizeOutlineV2', () => {
  test('in-progress legacy deck: pending phases, allResolved false, no duplication invariant', () => {
    const outline = canonicalizeOutlineV2(makeRecord(makeOutlines(6)), 'Legacy Deck');

    expect(outline.blueprint?.lessons[0].outlines).toHaveLength(6);
    expect(outline.lessonGroups?.[0].jobs).toHaveLength(6);
    expect(outline.outlines).toHaveLength(6); // compat projection kept
    expect(outline.completion?.allResolved).toBe(false);

    const job = outline.lessonGroups![0].jobs[0];
    expect(job.phases.content.status).toBe('pending');
    expect(job.phases.tts.status).toBe('pending');
  });

  test('complete legacy deck: content/actions done, fill phases pending, allResolved true', () => {
    const outline = canonicalizeOutlineV2(makeRecord(makeOutlines(6), true), 'Legacy Deck');

    expect(outline.completion?.allResolved).toBe(true);
    const job = outline.lessonGroups![0].jobs[0];
    expect(job.phases.content.status).toBe('done');
    expect(job.phases.actions.status).toBe('done');
    expect(job.phases.tts.status).toBe('pending');
    expect(job.phases.media.status).toBe('pending');
  });

  test('strips the legacy stageId key and keeps timestamps', () => {
    const outline = canonicalizeOutlineV2(makeRecord(makeOutlines(5), true), 'Deck');
    expect('stageId' in outline).toBe(false);
    expect(outline.createdAt).toBe(100);
    expect(outline.updatedAt).toBe(200);
  });
});
