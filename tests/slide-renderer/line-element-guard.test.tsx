// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/slide-renderer/components/hooks/useElementShadow', () => ({
  useElementShadow: () => ({ shadowStyle: undefined }),
}));

import {
  hasLinePoints,
  BaseLineElement,
} from '@/components/slide-renderer/components/element/LineElement/BaseLineElement';
import { LineElement } from '@/components/slide-renderer/components/element/LineElement';

const valid = {
  id: 'l1',
  type: 'line',
  left: 0,
  top: 0,
  width: 2,
  start: [0, 0],
  end: [30, 10],
  style: 'solid',
  color: '#000',
  points: ['', ''],
} as never;
const noPoints = { id: 'l2', type: 'line', left: 0, top: 0, width: 2, height: 40 } as never;

describe('a line without points', () => {
  it('is recognised', () => {
    expect(hasLinePoints(valid)).toBe(true);
    expect(hasLinePoints(noPoints)).toBe(false);
    expect(hasLinePoints({ start: [0, 0], end: [Number.NaN, 1] } as never)).toBe(false);
    expect(hasLinePoints({ start: [0], end: [1, 1] } as never)).toBe(false);
  });

  it('renders nothing instead of throwing, in playback and in the editor', () => {
    expect(() => renderToStaticMarkup(<BaseLineElement elementInfo={noPoints} />)).not.toThrow();
    expect(renderToStaticMarkup(<BaseLineElement elementInfo={noPoints} />)).toBe('');
    expect(renderToStaticMarkup(<LineElement elementInfo={noPoints} />)).toBe('');
  });

  it('still draws a proper line', () => {
    expect(renderToStaticMarkup(<BaseLineElement elementInfo={valid} />)).toContain('<svg');
  });
});
