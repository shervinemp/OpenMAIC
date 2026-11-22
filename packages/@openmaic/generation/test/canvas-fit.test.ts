import { describe, expect, it } from 'vitest';

import {
  SLIDE_VIEWPORT_RATIO,
  SLIDE_VIEWPORT_SIZE,
  findCanvasOverflows,
  isCaptionText,
  isSubstantiveText,
  validateSlideDepth,
} from '../src/content-depth.js';
import type { SceneOutline } from '../src/outline-types.js';
import type { PPTElement } from '@openmaic/dsl';

function element(top: number, height: number, content: string, left = 60, width = 880): PPTElement {
  return {
    id: `text_${top}`,
    type: 'text',
    top,
    left,
    width,
    height,
    content,
  } as PPTElement;
}

const outline = {
  id: 'scene_canvas',
  type: 'slide',
  title: 'Worked example',
  description: '',
  keyPoints: [],
} as unknown as SceneOutline;

describe('canvas fit', () => {
  it('accepts content inside the renderer viewport', () => {
    expect(findCanvasOverflows([element(50, 100, 'Body text')])).toEqual([]);
  });

  it('flags content that extends below the canvas', () => {
    const findings = findCanvasOverflows([element(1000, 360, 'Deep content')]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('y=1360');
    expect(findings[0]).toContain(String(Math.round(SLIDE_VIEWPORT_SIZE * SLIDE_VIEWPORT_RATIO)));
  });

  it('flags content that extends past the right edge', () => {
    const findings = findCanvasOverflows([element(50, 100, 'Wide', 900, 200)]);
    expect(findings.some((finding) => finding.includes('x=1100'))).toBe(true);
  });

  it('makes an overlong slide inadequate even when its prose is substantive', () => {
    const report = validateSlideDepth(outline, [
      element(1000, 400, 'A complete sentence with a verb and a number 30°C in it.'),
    ]);
    expect(report.adequate).toBe(false);
    expect(report.findings.some((finding) => finding.includes('canvas'))).toBe(true);
  });
});

describe('depth heuristics', () => {
  it('does not treat a numbered full sentence as a caption fragment', () => {
    const text = '1. Higher temperature increases the evaporation rate.';
    expect(isCaptionText(text)).toBe(false);
    expect(isSubstantiveText(text)).toBe(true);
  });

  it('still treats a bare numeral and a noun label as captions', () => {
    expect(isCaptionText('1')).toBe(true);
    expect(isCaptionText('2. Evaporation')).toBe(true);
  });

  it('counts science units as concrete examples', () => {
    const report = validateSlideDepth(outline, [
      element(50, 100, 'Water at 30°C evaporates faster than water at 20°C.'),
      element(160, 100, 'The sample absorbs 2,400 kJ per kilogram as it changes state.'),
    ]);
    expect(report.exampleCount).toBeGreaterThan(0);
    expect(report.findings.some((finding) => finding.includes('no concrete example'))).toBe(false);
  });
});
