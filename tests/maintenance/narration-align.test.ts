import { describe, expect, it } from 'vitest';

import { alignActionsToParts } from '@/lib/maintenance/narration-align';
import { computeSplitPlan } from '@/lib/maintenance/split-plan';

const speech = (text: string) => ({ type: 'speech', text });

describe('alignActionsToParts', () => {
  it('sends each line to the part it is about, in order', () => {
    const parts = [
      'Storage formats: open Parquet files versus proprietary formats',
      'Transactions: ACID guarantees, isolation and the transaction log',
      'Cost and scaling: compute separated from cheap object storage',
    ];
    const lines = [
      speech('Let us start with storage formats and why open Parquet files matter.'),
      speech('Proprietary formats lock you in.'),
      speech('Next, transactions: the transaction log gives ACID guarantees.'),
      speech('Isolation keeps readers safe.'),
      speech('Finally cost: compute scales separately from cheap object storage.'),
    ];

    expect(alignActionsToParts(lines, parts)).toEqual([0, 0, 1, 1, 2]);
  });

  it('never leaves a part silent when there are enough lines', () => {
    const placement = alignActionsToParts(
      [speech('alpha'), speech('beta'), speech('gamma'), speech('delta')],
      ['nothing in common', 'with these', 'lines at all'],
    );

    expect(new Set(placement)).toEqual(new Set([0, 1, 2]));
    // Monotonic: narration never goes back to an earlier part.
    expect([...placement].sort((a, b) => a - b)).toEqual(placement);
  });

  it('lets non-narration actions ride with the line they precede', () => {
    const actions = [
      { type: 'wb_open' },
      speech('Storage formats first.'),
      { type: 'discussion' },
      speech('Transactions next.'),
      { type: 'wb_close' },
    ];

    expect(
      alignActionsToParts(actions, ['storage formats overview', 'transactions and logs']),
    ).toEqual([0, 0, 1, 1, 1]);
  });

  it('keeps everything on a single part', () => {
    expect(alignActionsToParts([speech('a'), speech('b')], ['only part'])).toEqual([0, 0]);
  });
});

describe('computeSplitPlan without anchors', () => {
  // An overfull slide: rows stacked well past the canvas, no spotlight
  // anywhere, so the old interpolation put every action on chunk 0.
  const rows = [
    'Storage formats: open Parquet files versus proprietary formats',
    'Transactions: ACID guarantees and the transaction log',
    'Workloads: machine learning and BI on one copy',
    'Cost and scaling: compute separated from object storage',
  ];
  const scene = {
    id: 'scene-1',
    type: 'slide',
    title: 'Lake vs warehouse',
    order: 1,
    content: {
      type: 'slide',
      canvas: {
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: rows.map((text, i) => ({
          id: `row-${i}`,
          type: 'text',
          left: 40,
          top: 60 + i * 20,
          width: 900,
          height: 260,
          content: `<p style="font-size:18px">${text}</p>`,
        })),
      },
    },
    actions: [
      { id: 'a1', type: 'speech', text: 'Storage formats: open Parquet files matter.' },
      { id: 'a2', type: 'speech', text: 'Transactions come from the transaction log.' },
      { id: 'a3', type: 'speech', text: 'Workloads: machine learning and BI share data.' },
      { id: 'a4', type: 'speech', text: 'Cost: compute scales apart from object storage.' },
    ],
  };

  it('spreads the narration across the chunks instead of piling it on the first', () => {
    const plan = computeSplitPlan(scene);

    expect(plan?.chunks.length).toBeGreaterThan(1);
    const spoken = plan!.chunks.map((chunk) => chunk.actionIds.length);
    expect(spoken.every((count) => count > 0)).toBe(true);
    expect(plan!.chunks.flatMap((chunk) => chunk.actionIds)).toEqual(['a1', 'a2', 'a3', 'a4']);
  });
});
