import { describe, expect, test } from 'vitest';
import {
  formatWebSourceLegend,
  webSourcesToChunks,
} from '@/lib/generation/web-retrieval';
import {
  extractCitationMarkers,
  formatRetrievalContext,
  retrieveChunks,
  validateCitations,
} from '@/lib/generation/pdf-retrieval';
import type { WebSearchResult } from '@/lib/types/web-search';

function makeResult(): WebSearchResult {
  return {
    answer: 'summary',
    query: 'unit query',
    responseTime: 1,
    sources: [
      {
        title: 'Scheduling Policies',
        url: 'https://example.com/scheduling',
        content:
          'Round-robin scheduling cycles processes in fixed time slices. Each process receives an equal quantum of CPU time in order.',
        score: 0.9,
      },
      {
        title: 'Memory Paging',
        url: 'https://example.com/paging',
        content:
          'Paging divides memory into fixed-size frames. The page table maps virtual pages to physical frames with a valid bit.',
        score: 0.8,
      },
    ],
  };
}

describe('webSourcesToChunks (Phase 2 §15.2)', () => {
  test('chunks carry the 1-based source index as citation', () => {
    const chunks = webSourcesToChunks(makeResult());
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(['1', '2']).toContain(chunk.citation);
      expect(chunk.id.startsWith('web_')).toBe(true);
    }
    expect(new Set(chunks.map((c) => c.citation))).toEqual(new Set(['1', '2']));
  });

  test('source titles become chunk headings for scoring', () => {
    const chunks = webSourcesToChunks(makeResult());
    const first = chunks.find((c) => c.citation === '1')!;
    expect(first.heading).toBe('Scheduling Policies');
  });

  test('retrieval finds the right source for a scene query', () => {
    const chunks = webSourcesToChunks(makeResult());
    const retrieved = retrieveChunks('Compare page tables and virtual memory', chunks);
    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved.some((c) => c.citation === '2')).toBe(true);
  });

  test('citation ground-truth accepts bare-number web markers', () => {
    const chunks = webSourcesToChunks(makeResult());
    const retrieved = retrieveChunks('paging memory frames', chunks);
    const context = formatRetrievalContext(retrieved);
    const cited = extractCitationMarkers('[source 2] explains frames');
    expect(cited).toEqual(['2']);
    // Markers from the retrieved set validate; anything else is hallucinated.
    const valid = validateCitations(
      retrieved.map((c) => c.citation),
      retrieved,
    );
    expect(valid.valid).toBe(true);
    expect(valid.invalidMarkers).toEqual([]);
    const bogus = validateCitations(['7'], retrieved);
    expect(bogus.valid).toBe(false);
    expect(context).toContain('[source 2]');
  });
});

describe('formatWebSourceLegend', () => {
  test('maps markers to titles and urls', () => {
    const legend = formatWebSourceLegend(makeResult());
    expect(legend).toContain('1. Scheduling Policies — https://example.com/scheduling');
    expect(legend).toContain('2. Memory Paging — https://example.com/paging');
  });

  test('is empty without sources', () => {
    expect(formatWebSourceLegend({ ...makeResult(), sources: [] })).toBe('');
  });
});
