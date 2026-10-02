import { describe, expect, it } from 'vitest';

import { figureShapeToElement } from '@/lib/maintenance/figure-elements';

const line = (width: number, height: number) =>
  figureShapeToElement({ id: 'fig_l', kind: 'line', left: 10, top: 20, width, height });

describe('figureShapeToElement', () => {
  it('draws a connector between two points, as the renderer requires', () => {
    const element = line(180, 134) as {
      start: number[];
      end: number[];
      type: string;
      width: number;
    };
    expect(element.type).toBe('line');
    expect(element.start).toEqual([0, 0]);
    expect(element.end).toEqual([180, 134]);
    // `width` on a line is its stroke, not its span.
    expect(element.width).toBe(2);
  });

  it('turns a flat box into a horizontal rule and a narrow one into a vertical rule', () => {
    expect((line(200, 2) as { end: number[] }).end).toEqual([200, 0]);
    expect((line(2, 120) as { end: number[] }).end).toEqual([0, 120]);
  });

  it('always yields finite points, even for a degenerate box', () => {
    const element = line(0, 0) as { start: number[]; end: number[] };
    for (const value of [...element.start, ...element.end])
      expect(Number.isFinite(value)).toBe(true);
  });

  it('keeps boxes as labelled shapes', () => {
    const box = figureShapeToElement({
      id: 'fig_b',
      kind: 'box',
      left: 1,
      top: 2,
      width: 150,
      height: 60,
      label: 'dim_date',
    });
    expect(box).toMatchObject({ type: 'shape', width: 150, height: 60, text: 'dim_date' });
  });
});
