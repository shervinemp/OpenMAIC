import { describe, expect, test } from 'vitest';
import {
  validateComparisonDepth,
  validateDataReadingDepth,
  validateFreeResponseDepth,
  validateTradeoffsDepth,
} from '@/lib/generation/content-depth';
import {
  renderComparisonToElements,
  renderDataReadingToElements,
  renderFreeResponseToElements,
  renderTradeoffsToElements,
} from '@/lib/generation/specialized-scene-render';
import { isSlideLikeOutline, changeOutlineType } from '@/lib/generation/outline-type';
import { validateOutlineShape } from '@/lib/generation/blueprint';
import type {
  SceneOutline,
  GeneratedComparisonContent,
  GeneratedDataReadingContent,
  GeneratedTradeoffsContent,
  GeneratedFreeResponseContent,
} from '@/lib/types/generation';

function outline(type: SceneOutline['type'], depthLevel?: SceneOutline['depthLevel']): SceneOutline {
  return {
    id: `${type}_1`,
    type,
    title: 'Analytic scene',
    description: 'Teach the technique.',
    keyPoints: ['a', 'b'],
    order: 1,
    ...(depthLevel ? { depthLevel } : {}),
  };
}

const adequateComparison: GeneratedComparisonContent = {
  subjects: ['TCP', 'UDP'],
  rows: [
    {
      id: 'r1',
      dimension: 'Connection model',
      cells: [
        'TCP is connection-oriented and performs a three-way handshake before any data flows.',
        'UDP is connectionless; datagrams are sent without any prior setup round-trip.',
      ],
    },
    {
      id: 'r2',
      dimension: 'Reliability guarantee',
      cells: [
        'TCP retransmits lost segments and delivers bytes in order.',
        'UDP offers no delivery or ordering guarantees at all.',
      ],
    },
    {
      id: 'r3',
      dimension: 'Typical latency overhead',
      cells: [
        'The handshake and acknowledgements add at least one RTT before the first byte plus ongoing ACK traffic.',
        'UDP adds no per-message protocol delay beyond a single datagram transmission.',
      ],
    },
  ],
  takeaways: ['Choose TCP when correctness matters more than latency; choose UDP for real-time media.'],
};

describe('validateComparisonDepth', () => {
  test('accepts an adequate comparison table', () => {
    expect(validateComparisonDepth(outline('comparison', 'intro'), adequateComparison).adequate).toBe(
      true,
    );
  });

  test('rejects too few dimension rows', () => {
    const report = validateComparisonDepth(outline('comparison', 'intro'), {
      ...adequateComparison,
      rows: adequateComparison.rows.slice(0, 2),
    });
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('complete dimension row'))).toBe(true);
  });

  test('rejects rows whose cell count does not match the subject count', () => {
    const report = validateComparisonDepth(outline('comparison'), {
      subjects: ['A', 'B'],
      rows: [{ id: 'r1', dimension: 'Cost', cells: ['Only one complete sentence here.'] }],
    });
    expect(report.adequate).toBe(false);
    expect(
      report.findings.some((f) => f.includes('one cell per subject')),
    ).toBe(true);
  });

  test('rejects fragment cells (caption text)', () => {
    const report = validateComparisonDepth(outline('comparison'), {
      subjects: ['A', 'B'],
      rows: [
        { id: 'r1', dimension: 'Cost', cells: ['Cheap', 'Expensive'] },
        { id: 'r2', dimension: 'Speed', cells: ['Fast', 'Slow'] },
        {
          id: 'r3',
          dimension: 'Ordering',
          cells: [
            'Packets are numbered and reassembled in sequence order.',
            'Datagrams may arrive out of order or not at all.',
          ],
        },
      ],
    });
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('bare fragment'))).toBe(true);
  });

  test('renders one element per row plus header and takeaway', () => {
    const elements = renderComparisonToElements(outline('comparison'), adequateComparison);
    const texts = elements.map((el) => ('content' in el ? String(el.content) : ''));
    expect(texts.some((t) => t.includes('TCP') && t.includes('UDP'))).toBe(true); // header
    expect(texts.some((t) => t.includes('Connection model'))).toBe(true);
    expect(texts.some((t) => t.includes('Takeaway'))).toBe(true);
  });
});

const adequateDataReading: GeneratedDataReadingContent = {
  chartTitle: 'Cache hit rate vs. cache size',
  chartType: 'line',
  xAxisLabel: 'Cache size (KB)',
  yAxisLabel: 'Hit rate (%)',
  series: [
    {
      name: 'LRU',
      points: [
        { x: 4, y: 41.2 },
        { x: 8, y: 58.7 },
        { x: 16, y: 71.3 },
      ],
    },
  ],
  claims: [
    {
      id: 'c1',
      statement: 'Doubling cache size from 8 KB to 16 KB improves the hit rate by about 12 points.',
      verdict: 'supported',
      explanation: '71.3 - 58.7 = 12.6 percentage points, matching the claim.',
    },
    {
      id: 'c2',
      statement: 'Hit rate decreases as cache size grows.',
      verdict: 'refuted',
      explanation: 'The plotted values rise from 41.2 to 71.3 across the range.',
    },
  ],
};

describe('validateDataReadingDepth', () => {
  test('accepts an adequate data scene', () => {
    expect(validateDataReadingDepth(outline('dataReading', 'intro'), adequateDataReading).adequate).toBe(
      true,
    );
  });

  test('rejects explanations that cite no concrete values', () => {
    const report = validateDataReadingDepth(outline('dataReading'), {
      ...adequateDataReading,
      claims: adequateDataReading.claims.map((claim) =>
        claim.id === 'c1' ? { ...claim, explanation: 'The chart clearly shows this.' } : claim,
      ),
    });
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('cites no values'))).toBe(true);
  });

  test('rejects invalid verdict values', () => {
    const report = validateDataReadingDepth(
      outline('dataReading'),
      ({
        ...adequateDataReading,
        claims: [{ ...adequateDataReading.claims[0], verdict: 'maybe' }],
      }) as unknown as GeneratedDataReadingContent,
    );
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('verdict'))).toBe(true);
  });

  test('renders the chart description and per-claim verdict labels', () => {
    const elements = renderDataReadingToElements(outline('dataReading'), adequateDataReading);
    const texts = elements.map((el) => ('content' in el ? String(el.content) : ''));
    expect(texts.some((t) => t.includes('Cache hit rate vs. cache size'))).toBe(true);
    expect(texts.some((t) => t.includes('LRU'))).toBe(true);
    expect(texts.some((t) => t.includes('<strong>Supported</strong>'))).toBe(true);
    expect(texts.some((t) => t.includes('<strong>Refuted</strong>'))).toBe(true);
  });
});

const adequateTradeoffs: GeneratedTradeoffsContent = {
  context:
    'A four-engineer team must ship an analytics dashboard in six weeks against a Postgres cluster already near its connection limit.',
  constraints: ['6-week deadline with 4 engineers', 'Database connection count is capped'],
  options: [
    {
      id: 'opt-1',
      name: 'Materialized views on a schedule',
      pros: ['No new infrastructure to operate'],
      cons: ['Dashboard data can be stale by up to the refresh interval'],
      bestFor: 'Reporting where minute-level staleness is acceptable',
    },
    {
      id: 'opt-2',
      name: 'Dedicated read-replica pool',
      pros: ['Queries see near-real-time data'],
      cons: ['Adds a server to provision and monitor within the deadline'],
    },
  ],
  recommendation: {
    choice: 'Materialized views on a schedule',
    justification:
      'The binding constraints are the connection cap and the 6-week deadline; materialized views keep clients at one and require no new infrastructure.',
  },
};

describe('validateTradeoffsDepth', () => {
  test('accepts an adequate decision scene', () => {
    expect(validateTradeoffsDepth(outline('tradeoffs', 'intro'), adequateTradeoffs).adequate).toBe(true);
  });

  test('rejects options with no cons', () => {
    const report = validateTradeoffsDepth(outline('tradeoffs'), {
      ...adequateTradeoffs,
      options: adequateTradeoffs.options.map((o) =>
        o.id === 'opt-1' ? { ...o, cons: [] } : o,
      ),
    });
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('no cons'))).toBe(true);
  });

  test('rejects recommendations naming a non-existent option', () => {
    const report = validateTradeoffsDepth(outline('tradeoffs'), {
      ...adequateTradeoffs,
      recommendation: { choice: 'Quantum caching', justification: 'It wins under the constraints.' },
    });
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('no option carries that name'))).toBe(true);
  });

  test('renders context, both options, and a recommendation banner', () => {
    const elements = renderTradeoffsToElements(outline('tradeoffs'), adequateTradeoffs);
    const texts = elements.map((el) => ('content' in el ? String(el.content) : ''));
    expect(texts.some((t) => t.includes('Decision'))).toBe(true);
    expect(texts.some((t) => t.includes('Materialized views on a schedule'))).toBe(true);
    expect(texts.some((t) => t.includes('Recommendation: Materialized views on a schedule'))).toBe(
      true,
    );
  });
});

const adequateFreeResponse: GeneratedFreeResponseContent = {
  prompt:
    'Explain to a junior teammate why the retry storm made the p99 latency worse during the incident, using the stampede dynamics from the lesson. 150-250 words.',
  guidance: [
    'Name the failure mechanism before the fix.',
    'Use at least one concrete number from the lesson.',
  ],
  rubric: [
    {
      id: 'crit-1',
      criterion: 'Names the correct failure mechanism (retry storm, not general slowness).',
      weight: 'essential',
      lookFor:
        'The answer identifies synchronized retries amplifying load as the cause of the spike.',
    },
    {
      id: 'crit-2',
      criterion: 'Uses concrete lesson values rather than vague quantities.',
      weight: 'important',
      lookFor: 'At least one specific number (timeout, retry count, or request rate) appears.',
    },
  ],
  sampleAnswer:
    'The incident was a retry storm. When the dependency slowed, every caller retried after its own short timeout, so the request rate tripled at exactly the moment the backend had the least headroom. With a 2-second timeout and 3 retries per caller, a single failing request became four requests against an already saturated pool, which pushed p99 from 800ms to 9 seconds. The fix is not more capacity: it is bounded, jittered, token-bucket retry budgets so that retries shed load instead of amplifying it.',
};

describe('validateFreeResponseDepth', () => {
  test('accepts an adequate writing task', () => {
    expect(validateFreeResponseDepth(outline('freeResponse', 'intro'), adequateFreeResponse).adequate)
      .toBe(true);
  });

  test('rejects a rubric with no essential criterion', () => {
    const report = validateFreeResponseDepth(outline('freeResponse'), {
      ...adequateFreeResponse,
      rubric: adequateFreeResponse.rubric.map((c) => ({ ...c, weight: 'bonus' as const })),
    });
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('no essential criterion'))).toBe(true);
  });

  test('rejects a thin sample answer', () => {
    const report = validateFreeResponseDepth(outline('freeResponse'), {
      ...adequateFreeResponse,
      sampleAnswer: 'Retries are bad.',
    });
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('sample answer is only'))).toBe(true);
  });

  test('rejects a bare-topic prompt', () => {
    const report = validateFreeResponseDepth(outline('freeResponse'), {
      ...adequateFreeResponse,
      prompt: 'Retry storms',
    });
    expect(report.adequate).toBe(false);
    expect(report.findings.some((f) => f.includes('bare topic label'))).toBe(true);
  });

  test('renders the task box, rubric weights, and the strong answer', () => {
    const elements = renderFreeResponseToElements(outline('freeResponse'), adequateFreeResponse);
    const texts = elements.map((el) => ('content' in el ? String(el.content) : ''));
    expect(texts.some((t) => t.includes('Your task'))).toBe(true);
    expect(texts.some((t) => t.includes('[Essential]'))).toBe(true);
    expect(texts.some((t) => t.includes('Strong answer'))).toBe(true);
  });
});

describe('analytic kinds integrate with outline plumbing', () => {
  test.each(['comparison', 'dataReading', 'tradeoffs'] as const)(
    '%s is slide-like and survives type-change identity',
    (type) => {
      expect(isSlideLikeOutline(outline(type))).toBe(true);
      const switched = changeOutlineType(outline(type), type);
      expect(switched.type).toBe(type);
    },
  );

  test('validateOutlineShape accepts the analytic kinds and rejects unknown ones', () => {
    for (const type of ['comparison', 'dataReading', 'tradeoffs'] as const) {
      expect(validateOutlineShape(outline(type))).toEqual([]);
    }
    const bad = validateOutlineShape({
      ...(outline('slide') as SceneOutline),
      type: 'vibes' as SceneOutline['type'],
    });
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain('invalid scene type');
    expect(bad[0]).toContain('comparison');
  });
});

