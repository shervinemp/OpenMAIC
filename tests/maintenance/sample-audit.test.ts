import { describe, expect, it } from 'vitest';

import { auditScenesSample, sampleSizeFor } from '@/lib/maintenance/sample-audit';

const scene = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  content: {
    canvas: {
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [{ id: 't1', type: 'text', left: 10, top: 10, width: 100, height: 30, content: 'hello' }],
    },
    ...extra,
  },
});

describe('sample audit', () => {
  it('uses a conservative, finite-population-corrected sample size', () => {
    expect(sampleSizeFor(0)).toBe(0);
    expect(sampleSizeFor(100)).toBeLessThanOrEqual(100);
    expect(sampleSizeFor(2400)).toBeGreaterThan(Math.sqrt(2400));
    expect(sampleSizeFor(2400)).toBeLessThan(100);
  });

  it('selects reproducibly and flags only faulty sampled scenes', () => {
    const document = {
      scenes: [
        ...Array.from({ length: 39 }, (_, i) => scene(`clean-${i}`)),
        scene('faulty', { narration: 'See [source p.154] for details.' }),
      ],
    };
    const first = auditScenesSample(document, 'course-1');
    const second = auditScenesSample(document, 'course-1');

    expect(first.sampleSize).toBe(sampleSizeFor(40));
    expect(first.sampleSize).toBeLessThan(40);
    expect(first.findings).toEqual(second.findings);
    expect(first.summary.source + first.summary.layout).toBeGreaterThanOrEqual(0);
  });
});
