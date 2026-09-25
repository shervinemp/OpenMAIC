import { describe, expect, it, vi, afterEach } from 'vitest';
import { applyLayoutPatch, verifyAndRepairSlideLayout } from '@/lib/slides/slide-layout-verify';
import type { SlideContent } from '@openmaic/dsl';

function slideContent(elements: Array<Record<string, unknown>>): SlideContent {
  return {
    type: 'slide',
    schemaVersion: 1,
    canvas: {
      id: 'slide-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {},
      elements,
    },
  } as unknown as SlideContent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('applyLayoutPatch', () => {
  it('merges only rect fields and keeps identity of everything else', () => {
    const source = [
      {
        id: 'a',
        type: 'text',
        left: 0,
        top: 0,
        width: 500,
        height: 100,
        rotate: 0,
        content: '<p>keep</p>',
      },
      {
        id: 'b',
        type: 'text',
        left: 10,
        top: 20,
        width: 400,
        height: 200,
        rotate: 0,
        content: '<p>keep2</p>',
      },
    ];
    const canvas = { viewportSize: 1000, viewportRatio: 0.5625, elements: source };
    const applied = applyLayoutPatch(canvas, [
      { id: 'a', left: 100, top: 10, width: 500, height: 100, content: '<p>evil</p>' },
      { id: 'b', left: 20, top: 40, width: 400, height: 200 },
    ]);
    expect(applied).toBe(true);
    expect(canvas.elements[0].content).toBe('<p>keep</p>');
    expect(canvas.elements[0].left).toBe(100);
    expect(canvas.elements.length).toBe(2);
  });

  it('rejects a patch that drops an element id', () => {
    const canvas = {
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [
        { id: 'a', type: 'text', left: 0, top: 0, width: 10, height: 10, rotate: 0 },
        { id: 'b', type: 'text', left: 0, top: 0, width: 10, height: 10, rotate: 0 },
      ],
    };
    expect(applyLayoutPatch(canvas, [canvas.elements[0]] as never)).toBe(false);
  });

  it('rejects resizes beyond ±20%', () => {
    const canvas = {
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [{ id: 'a', type: 'text', left: 0, top: 0, width: 100, height: 100, rotate: 0 }],
    };
    const applied = applyLayoutPatch(canvas, [
      { id: 'a', left: 0, top: 0, width: 300, height: 100 } as never,
    ]);
    expect(applied).toBe(true);
    expect(canvas.elements[0].width).toBe(100);
  });
});

describe('verifyAndRepairSlideLayout', () => {
  it('clamps out-of-bounds elements with zero LLM involvement', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const content = slideContent([
      {
        id: 'bar',
        type: 'shape',
        left: 86,
        top: 642,
        width: 4,
        height: 420,
        rotate: 0,
        viewBox: [200, 200],
        path: 'M0 0 L200 200',
        fill: '#ff8800',
      },
      {
        id: 'body',
        type: 'text',
        left: 40,
        top: 40,
        width: 520,
        height: 120,
        rotate: 0,
        content: '<p>ok</p>',
      },
    ]);
    const trigger = content as unknown as { canvas: { elements: Array<Record<string, unknown>> } };
    const result = await verifyAndRepairSlideLayout(content);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.repairFailed).toBe(false);
    expect(result.clamped).toBe(1);
    expect(trigger.canvas.elements[0].top).toBe(142);
  });

  it('calls the layout repair route when clamping cannot clear the findings', async () => {
    const response = {
      ok: true,
      status: 200,
      json: async () => ({
        layoutPatch: {
          elements: [
            { id: 'a', left: 0, top: 0, width: 500, height: 100 },
            { id: 'b', left: 40, top: 150, width: 500, height: 400 },
          ],
        },
      }),
    };
    const fetchSpy = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchSpy);
    const content = slideContent([
      {
        id: 'a',
        type: 'text',
        left: 0,
        top: 0,
        width: 500,
        height: 100,
        rotate: 0,
        content: '<p>x</p>',
      },
      {
        id: 'b',
        type: 'text',
        left: 40,
        top: 10,
        width: 500,
        height: 400,
        rotate: 0,
        content: '<p>y</p>',
      },
    ]);
    const result = await verifyAndRepairSlideLayout(content);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.repaired).toBe(true);
    expect(result.repairFailed).toBe(false);
    expect(result.findings).toHaveLength(0);
  });
});
