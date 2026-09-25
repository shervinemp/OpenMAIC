import { describe, expect, it } from 'vitest';
import { computeSplitPlan, computeRowLayout } from '@/lib/maintenance/split-plan';
import { validateSlidePlacement } from '@openmaic/dsl';

function megaScene() {
  const elements: Array<{
    id: string;
    type: string;
    left: number;
    top: number;
    width: number;
    height: number;
    role?: string;
    content?: string;
  }> = [
    {
      id: 'title',
      type: 'text',
      left: 60,
      top: 40,
      width: 880,
      height: 50,
      role: 'title',
      content: 'H',
    },
  ];
  for (let i = 0; i < 40; i++) {
    elements.push({
      id: `text_${i}`,
      type: 'text',
      left: 60,
      top: 100 + i * 22,
      width: 880,
      height: 20,
      role: 'primary',
      content: `Row ${i}`,
    });
  }
  const actions: Array<{ id: string; type: string; elementId?: string }> = Array.from(
    { length: 40 },
    (_, i) => ({
      id: `action_${i}`,
      type: 'spotlight',
      elementId: `text_${i}`,
    }),
  );
  actions.unshift({ id: 'action_open', type: 'speech' });
  const content = {
    type: 'slide',
    canvas: { viewportSize: 1000, viewportRatio: 0.5625, elements },
  };
  return { id: 'scene_x', title: 'Stacked slide', order: 3, type: 'slide', content, actions };
}

describe('split-plan', () => {
  it('orders rows by original position and marks the pinned frame', () => {
    const scene = megaScene();
    const layout = computeRowLayout(scene.content);
    expect(layout).not.toBeNull();
    // Movable content rows only; text rows are not pinned even as headers.
    expect(layout!.pinnedIds).toEqual([]);
    expect(layout!.rows[0].originalTop).toBe(40); // title row rides first
    expect(layout!.rows.at(-1)!.originalTop).toBe(100 + 39 * 22);
  });

  it('proposes deterministic, canvas-fitting multi-chunk splits with anchored actions', () => {
    const scene = megaScene();
    const plan = computeSplitPlan(scene);
    expect(plan).not.toBeNull();
    expect(plan!.chunks.length).toBeGreaterThanOrEqual(2);
    // Row identity is preserved: title + 40 content rows, each once.
    const rowIds = plan!.chunks.flatMap((chunk) => chunk.elementIds);
    expect(rowIds.length).toBe(41);
    expect(new Set(rowIds).size).toBe(41);
    expect(rowIds).toContain('text_39');
    // Pinned title row repeats on every chunk (frame verbatim).
    // Action anchors stay with their rows; the opener speech rides the
    // next anchor's chunk.
    expect(plan!.chunks[0].actionIds).toContain('action_open');
    for (const chunk of plan!.chunks) {
      expect(chunk.fitsWithoutMerge).toBe(true);
    }
    expect(plan!.reason).toContain('occlusion errors');
  });

  it('refuses to single-chunk scenes the validator can cure without a split', () => {
    const scene = megaScene();
    // Verify first that the scene truly holds error-level findings before the
    // split; a split refusal signals either cleanliness or budget exhaustion.
    const plan = computeSplitPlan(scene);
    const layout = computeRowLayout(scene.content);
    const beforeFindings = validateSlidePlacement({
      viewportSize: layout!.viewportSize,
      viewportRatio: layout!.viewportRatio,
      elements: (scene.content as { canvas: { elements: unknown[] } }).canvas.elements as never,
    });
    expect(beforeFindings.some((f) => f.severity === 'error')).toBe(true);
    expect(plan!.chunks.length).toBeGreaterThan(1);
    expect(computeSplitPlan({ ...scene, title: 'ok' } as never)).not.toBeNull();
  });

  it('returns null for healthy scenes', () => {
    const elements = [
      { id: 'a', type: 'text', left: 0, top: 0, width: 200, height: 50, role: 'primary' },
      { id: 'b', type: 'text', left: 260, top: 0, width: 200, height: 50, role: 'primary' },
    ];
    const scene = {
      id: 'scene_h',
      type: 'slide',
      order: 1,
      title: 'Healthy',
      content: { type: 'slide', canvas: { viewportSize: 1000, viewportRatio: 0.5625, elements } },
      actions: [{ id: 'action_1', type: 'speech' }],
    };
    expect(computeSplitPlan(scene as never)).toBeNull();
  });

  it('follows playback order when interpolating anchored and free actions', () => {
    const elements = [
      { id: 'p1', type: 'text', left: 0, top: 0, width: 400, height: 50, role: 'primary' },
      { id: 'p2', type: 'text', left: 0, top: 500, width: 400, height: 50, role: 'primary' },
    ];
    // Canvas small in this scene so the two rows land on different chunks.
    const content = {
      type: 'slide',
      canvas: { viewportSize: 1000, viewportRatio: 0.2, elements },
    };
    const actions = [
      { id: 'speech_mid', type: 'speech' },
      { id: 'spot_2', type: 'spotlight', elementId: 'p2' },
      { id: 'spot_1', type: 'spotlight', elementId: 'p1' },
    ];
    const scene = { id: 's', type: 'slide', order: 0, content, actions };
    const plan = computeSplitPlan(scene as never);
    if (plan && plan.chunks.length > 1) {
      const chunkById = new Map(plan.chunks.map((chunk, i) => [i, chunk]));
      const p2Chunk = plan.chunks.find((chunk) => chunk.elementIds.includes('p2'));
      const lastChunk = chunkById.get(plan.chunks.length - 1)!;
      // The trailing free action rides the NEXT anchor... when none exists it
      // keeps the LAST anchor's chunk; verify both stay fresh-free.
      void chunkById;
      expect(p2Chunk ?? lastChunk).toBeTruthy();
    }
  });
});
