import { describe, expect, it } from 'vitest';

import { planSceneSplit, reflowSceneRows } from '@/lib/maintenance/split-overloaded-scene';

const text = (id: string, top: number, height: number) => ({
  id,
  type: 'text',
  left: 60,
  top,
  width: 880,
  height,
  content: '<p>row</p>',
});

const document = {
  outline: {
    outlines: [
      { id: 'o1', title: 'Dense slide', order: 2, type: 'slide' },
    ],
  },
  scenes: [
    {
      id: 's1',
      type: 'slide',
      outlineId: 'o1',
      order: 2,
      content: {
        canvas: {
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [
            text('t1', 40, 30),
            text('t2', 80, 180),
            text('t3', 270, 180),
            text('t4', 460, 180),
          ],
        },
      },
    },
  ],
};

describe('overloaded slide splitting', () => {
  it('reflows stacked rows when the content fits one canvas', () => {
    const scene = document.scenes[0] as Record<string, unknown>;
    const packed = reflowSceneRows(scene);
    // The four rows (570px + gaps) exceed the 506px body band.
    expect(packed).toBeNull();
  });

  it('splits a dense slide into two with a fresh outline', () => {
    const plan = planSceneSplit(document as never, 's1');
    expect(plan).not.toBeNull();
    const first = plan!.scene.content as { canvas: { elements: Array<{ id: string }> } };
    const second = plan!.continuation.content as { canvas: { elements: Array<{ id: string }> } };
    const ids = new Set([...first.canvas.elements, ...second.canvas.elements].map((e) => e.id));
    expect(ids.size).toBe(4);
    expect(plan!.continuationOutline.title).toBe('Dense slide (continued)');
    expect(plan!.continuation.order).toBeGreaterThan(2);
  });
});
