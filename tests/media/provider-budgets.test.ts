import { afterEach, describe, expect, it, vi } from 'vitest';
import { mediaProviderBudgets, takeWithinMediaCaps } from '@/lib/media/provider-budgets';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('media provider budgets', () => {
  it('defaults first-pass caps to 40 images / 8 videos', () => {
    const budgets = mediaProviderBudgets();
    expect(budgets.image.generationCap).toBe(40);
    expect(budgets.video.generationCap).toBe(8);
    expect(budgets.image.requeueCap).toBe(40);
    expect(budgets.video.requeueCap).toBe(8);
  });

  it('honors the generation and requeue env overrides', () => {
    vi.stubEnv('COURSE_MEDIA_IMAGE_GENERATION_LIMIT', '3');
    vi.stubEnv('COURSE_MEDIA_VIDEO_GENERATION_LIMIT', '1');
    vi.stubEnv('COURSE_MEDIA_IMAGE_REQUEUE_LIMIT', '5');
    vi.stubEnv('COURSE_MEDIA_VIDEO_REQUEUE_LIMIT', '2');

    const budgets = mediaProviderBudgets();
    expect(budgets.image.generationCap).toBe(3);
    expect(budgets.video.generationCap).toBe(1);
    expect(budgets.image.requeueCap).toBe(5);
    expect(budgets.video.requeueCap).toBe(2);
  });

  it('takes requests per class in the caller-supplied order', () => {
    const requests = [
      { id: 'i1', type: 'image' as const },
      { id: 'i2', type: 'image' as const },
      { id: 'v1', type: 'video' as const },
      { id: 'i3', type: 'image' as const },
      { id: 'v2', type: 'video' as const },
    ];

    expect(takeWithinMediaCaps(requests, { image: 2, video: 1 })).toEqual([
      { id: 'i1', type: 'image' },
      { id: 'i2', type: 'image' },
      { id: 'v1', type: 'video' },
    ]);
  });

  it('returns every request when the caps are above the backlog', () => {
    const requests = [
      { id: 'i1', type: 'image' as const },
      { id: 'v1', type: 'video' as const },
    ];
    expect(takeWithinMediaCaps(requests, { image: 10, video: 10 })).toEqual(requests);
  });
});
