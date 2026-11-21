import { describe, expect, it, vi } from 'vitest';

import { takeSceneDepthSummary } from '../src/content-depth.js';
import type { SceneOutline } from '../src/outline-types.js';
import { generateSceneContent } from '../src/scene-generator.js';

const slideOutline = {
  id: 'scene_depth_exhausted',
  order: 1,
  type: 'slide',
  title: 'Evaporation and Transpiration',
  description: 'How water enters the air',
  keyPoints: [],
} as unknown as SceneOutline;

/** All captions, no substantive sentences — guaranteed to fail the depth floor. */
const shallowSlide = JSON.stringify({
  background: { type: 'solid', color: '#ffffff' },
  elements: Array.from({ length: 8 }, (_, index) => ({
    id: `text_${index}`,
    type: 'text',
    left: 40,
    top: 40 + index * 60,
    width: 800,
    height: 40,
    content: '<p>Short caption</p>',
    defaultFontName: '',
    defaultColor: '#333333',
  })),
});

describe('slide depth contract exhaustion', () => {
  it('keeps usable content and records findings instead of dropping the scene', async () => {
    const aiCall = vi.fn(async (_system: string, _user: string): Promise<string> => shallowSlide);

    const content = await generateSceneContent(slideOutline, aiCall);

    expect(content).not.toBeNull();
    expect((content as { elements: unknown[] }).elements.length).toBe(8);
    expect(aiCall.mock.calls.length).toBeGreaterThan(1);

    const summary = takeSceneDepthSummary(slideOutline.id);
    expect(summary?.reworked).toBe(true);
    expect(summary?.findings.some((finding) => finding.startsWith('slide depth:'))).toBe(true);
  });
});
