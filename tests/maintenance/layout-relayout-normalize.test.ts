import { describe, expect, it } from 'vitest';

import { normalizeFullBleedRows } from '@/lib/maintenance/layout-relayout';

function scene(element: Record<string, unknown>) {
  return {
    content: {
      type: 'slide',
      canvas: {
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [element],
      },
    },
  };
}

describe('normalizeFullBleedRows', () => {
  it('keeps an in-canvas text row at its content height instead of shrinking it', () => {
    const element = {
      type: 'text',
      left: 60,
      top: 474,
      width: 880,
      height: 79,
      content: '<p>Last row on a packed split page.</p>',
    };
    expect(normalizeFullBleedRows(scene(element))).toBe(0);
    expect(element.top).toBe(474);
    expect(element.height).toBe(79);
  });

  it('clamps a text row that genuinely overflows the canvas', () => {
    const element = {
      type: 'text',
      left: 60,
      top: 550,
      width: 880,
      height: 60,
      content: '<p>Runaway row.</p>',
    };
    expect(normalizeFullBleedRows(scene(element))).toBe(1);
    expect(element.top + element.height).toBeLessThanOrEqual(555);
  });
});
