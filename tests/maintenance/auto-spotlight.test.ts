import { describe, expect, it } from 'vitest';

import { withAutoSpotlights } from '@/lib/maintenance/auto-spotlight';
import { healCourseIntegrity } from '@/lib/maintenance/course-integrity';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';

const text = (id: string, words: string) => ({
  id,
  type: 'text',
  left: 40,
  top: 40,
  width: 800,
  height: 60,
  content: `<p>${words}</p>`,
});
const speech = (id: string, words: string) => ({ id, type: 'speech', text: words }) as Action;
const slide = (actions: Action[], elements = rows) =>
  ({
    id: 'slide',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Comparison',
    order: 1,
    content: { type: 'slide', canvas: { id: 'canvas', elements } },
    actions,
  }) as unknown as Scene;

const rows = [
  text('storage', 'Storage format and openness: Parquet files, open formats, vendor lock-in'),
  text('acid', 'Transactional guarantees: ACID commits, isolation, the transaction log'),
  text('cost', 'Cost and scaling model: cheap object storage, elastic compute clusters'),
];

describe('withAutoSpotlights', () => {
  it('points at the element a line is unmistakably about, before the line', () => {
    const next = withAutoSpotlights(
      slide([
        speech('l1', 'First, open formats: Parquet files avoid vendor lock-in.'),
        speech('l2', 'Then ACID commits and isolation through the transaction log.'),
      ]),
    );

    expect(next?.map((a) => [a.type, (a as { elementId?: string }).elementId ?? a.id])).toEqual([
      ['spotlight', 'storage'],
      ['speech', 'l1'],
      ['spotlight', 'acid'],
      ['speech', 'l2'],
    ]);
    expect(next?.[0]?.id).toBe('auto-spotlight-l1');
  });

  it('adds nothing for a line that matches no element clearly', () => {
    expect(
      withAutoSpotlights(slide([speech('l1', 'Welcome back, everyone, let us get started.')])),
    ).toBeNull();
  });

  it('keeps one spotlight across consecutive lines about the same element', () => {
    const next = withAutoSpotlights(
      slide([
        speech('l1', 'Cheap object storage keeps the cost and scaling model low.'),
        speech('l2', 'Elastic compute clusters scale that cost model on demand.'),
      ]),
    );

    expect(next?.filter((a) => a.type === 'spotlight')).toHaveLength(1);
  });

  it('never touches a slide whose author placed anchors, or one with a single text', () => {
    expect(
      withAutoSpotlights(
        slide([
          { id: 's', type: 'spotlight', elementId: 'acid' } as Action,
          speech('l1', 'Parquet files avoid vendor lock-in.'),
        ]),
      ),
    ).toBeNull();
    expect(
      withAutoSpotlights(slide([speech('l1', 'Parquet files avoid lock-in.')], [rows[0]!])),
    ).toBeNull();
  });

  it('recognizes its own work on a second pass', () => {
    const once = withAutoSpotlights(
      slide([speech('l1', 'Open formats: Parquet files avoid vendor lock-in.')]),
    );

    expect(withAutoSpotlights(slide(once!))).toBeNull();
  });
});

describe('the integrity pass adds spotlights', () => {
  const course = () => [slide([speech('l1', 'Open formats: Parquet files avoid vendor lock-in.')])];

  it('by default', () => {
    const heal = healCourseIntegrity(course());

    expect(heal.report.spotlightsAdded).toBe(1);
    expect(heal.updates[0]?.patch.actions?.[0]).toMatchObject({
      type: 'spotlight',
      elementId: 'storage',
    });
  });

  it('not when switched off', () => {
    const heal = healCourseIntegrity(course(), { autoSpotlight: false });

    expect(heal.report.spotlightsAdded).toBe(0);
    expect(heal.updates).toEqual([]);
  });
});
