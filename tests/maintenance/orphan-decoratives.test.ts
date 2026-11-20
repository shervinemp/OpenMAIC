import { describe, expect, it } from 'vitest';

import { hasOrphanDecoratives, stripOrphanDecoratives } from '@/lib/maintenance/layout-relayout';

function scene(elements: Array<Record<string, unknown>>) {
  return {
    content: {
      type: 'slide',
      canvas: {
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements,
      },
    },
  };
}

const text = {
  id: 'text-1',
  type: 'text',
  left: 60,
  top: 130,
  width: 400,
  height: 300,
  content: '<p>Collection</p>',
};

const image = {
  id: 'img-1',
  type: 'image',
  left: 520,
  top: 130,
  width: 420,
  height: 300,
  src: 'ast_generated',
};

const decorative = {
  id: 'shape-1',
  type: 'shape',
  left: 520,
  top: 130,
  width: 420,
  height: 300,
  path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
  fill: '#eeeeee',
};

describe('orphan decorative stripping', () => {
  it('keeps an interior image that no text overlaps', () => {
    const target = scene([text, image]);

    expect(hasOrphanDecoratives(target)).toBe(false);
    expect(stripOrphanDecoratives(target)).toBe(0);
    expect(target.content.canvas.elements.map((element) => element.id)).toEqual([
      'text-1',
      'img-1',
    ]);
  });

  it('still strips an interior decorative shape with no text over it', () => {
    const target = scene([text, decorative]);

    expect(hasOrphanDecoratives(target)).toBe(true);
    expect(stripOrphanDecoratives(target)).toBe(1);
    expect(target.content.canvas.elements.map((element) => element.id)).toEqual(['text-1']);
  });
});
