import { describe, expect, it } from 'vitest';
import { applySplit, canSplit } from '@/lib/maintenance/split-apply';
import type { SplitApplyDocumentShape } from '@/lib/maintenance/split-apply';

function document(): SplitApplyDocumentShape {
  const elements: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 30; i++) {
    elements.push({
      id: `text_${i}`,
      type: 'text',
      left: 60,
      top: 110 + i * 16,
      width: 880,
      height: 14,
      role: 'primary',
      content: `Row ${i}`,
    });
  }
  const mega: Record<string, unknown> = {
    id: 'sceneA',
    outlineId: 'scene_8',
    stageId: 'stage1',
    type: 'slide',
    title: 'Stacked slide',
    order: 8,
    content: {
      type: 'slide',
      canvas: { viewportSize: 1000, viewportRatio: 0.5625, elements },
      schemaVersion: 1,
    },
    actions: [
      { id: 'speechMid', type: 'speech', text: 't' },
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `spot_${i}`,
        type: 'spotlight',
        elementId: `text_${i}`,
      })),
    ],
    createdAt: 1,
    updatedAt: 1,
    actionsSourceHash: 'h1',
  };
  const sibling: Record<string, unknown> = {
    id: 'sceneB',
    outlineId: 'scene_9',
    stageId: 'stage1',
    type: 'slide',
    title: 'Next slide',
    order: 9,
    content: {
      type: 'slide',
      canvas: {
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [
          { id: 'x', type: 'text', left: 0, top: 0, width: 100, height: 40, role: 'primary' },
        ],
      },
    },
    actions: [{ id: 'bSpeech', type: 'speech', text: 'b' }],
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    stage: { id: 'stage1' },
    scenes: [mega, sibling],
    outline: {
      outlines: [
        {
          id: 'scene_8',
          type: 'slide',
          title: 'Stacked slide',
          description: 'd',
          keyPoints: [],
          order: 8,
          lessonId: 'lesson_2',
        },
        {
          id: 'scene_9',
          type: 'slide',
          title: 'Next slide',
          description: 'd9',
          keyPoints: [],
          order: 9,
          lessonId: 'lesson_2',
        },
      ],
      lessonGroups: [
        {
          lessonId: 'lesson_2',
          jobs: [
            { outlineId: 'scene_8', phases: { content: { status: 'done' } } },
            { outlineId: 'scene_9', phases: { content: { status: 'done' } } },
          ],
        },
      ],
      generationComplete: true,
      createdAt: 1,
      updatedAt: 1,
    },
    dslVersion: '0.3.0',
  };
}

describe('split-apply', () => {
  it('recognizes stacked debt scenes and produces >1 parts', () => {
    const doc = document();
    expect(canSplit(doc.scenes[0])).toBe(true);
    const result = applySplit(doc, 'sceneA');
    expect(result).not.toBeNull();
    expect(result!.parts.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps outline/scene 1:1 with matching unique orders after the split', () => {
    const doc = document();
    applySplit(doc, 'sceneA');
    const outlineById = new Map(doc.outline.outlines.map((entry) => [entry.id as string, entry]));
    const orders = doc.scenes.map((entry) => entry.order as number);
    expect(new Set(orders).size).toBe(doc.scenes.length);
    for (const scene of doc.scenes) {
      const outline = outlineById.get(String(scene.outlineId));
      expect(outline).toBeTruthy();
      expect(scene.order).toBe((outline as { order: number }).order);
    }
  });

  it('shifts sibling orders by exactly parts-minus-one', () => {
    const doc = document();
    const result = applySplit(doc, 'sceneA')!;
    const partsCount = result.parts.length;
    const sibling = doc.scenes.find((s) => s.id === 'sceneB')!;
    expect(sibling.order).toBe(9 + (partsCount - 1));
    const outlineEntry = doc.outline.outlines.find((entry) => entry.id === 'scene_9');
    expect((outlineEntry as unknown as { order: number }).order).toBe(9 + (partsCount - 1));
  });

  it('redistributes action rows: each original action stays exactly once', () => {
    const doc = document();
    applySplit(doc, 'sceneA');
    const actionIds = doc.scenes.flatMap((s) =>
      ((s.actions ?? []) as Array<{ id: string }>).map((a) => a.id),
    );
    expect(new Set(actionIds).size).toBe(32); // 30 spots + opener + sibling speech
    expect(actionIds.length).toBe(32);
  });

  it('carries tts/media verdicts onto every part job (fill-decay stays visible)', () => {
    const doc = document();
    const group = doc.outline.lessonGroups[0];
    const original = (group.jobs as Array<Record<string, unknown>>).find(
      (job) => job.outlineId === 'scene_8',
    )!;
    (original.phases as Record<string, unknown>).tts = {
      status: 'failed',
      attempts: 1,
      error: 'Narration bytes missing',
    };
    (original.phases as Record<string, unknown>).media = { status: 'pending', attempts: 0 };

    const result = applySplit(doc, 'sceneA')!;
    const partJobs = (group.jobs as Array<Record<string, unknown>>).filter((job) =>
      result.parts.some((part) => part.outlineId === job.outlineId),
    );
    expect(partJobs.length).toBe(result.parts.length);
    for (const job of partJobs) {
      const phases = job.phases as Record<string, { status: string; error?: string }>;
      expect(phases.tts?.status).toBe('failed');
      expect(phases.tts?.error).toBe('Narration bytes missing');
      expect(phases.media?.status).toBe('pending');
    }
  });

  it('leaves jobs without narration phases phase-free after the split', () => {
    const doc = document();
    const result = applySplit(doc, 'sceneA')!;
    const partJobs = (doc.outline.lessonGroups[0].jobs as Array<Record<string, unknown>>).filter(
      (job) => result.parts.some((part) => part.outlineId === job.outlineId),
    );
    for (const job of partJobs) {
      expect((job.phases as Record<string, unknown>).tts).toBeUndefined();
      expect((job.phases as Record<string, unknown>).media).toBeUndefined();
    }
  });
});
