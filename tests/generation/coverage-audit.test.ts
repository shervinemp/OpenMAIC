import { describe, expect, test } from 'vitest';
import {
  auditDigestCoverage,
  collectCitedMarkers,
  renderCoverageReport,
} from '@/lib/generation/coverage-audit';
import type { DocumentDigest } from '@/lib/generation/document-digest';
import { chunkSourceText, type PdfChunk } from '@/lib/generation/pdf-retrieval';
import type { SceneOutline } from '@/lib/types/generation';

const SOURCE = `Page 1

1.1 Introduction

The first section introduces the field.

Page 10

1.2 Concepts

The second section defines concepts.

Page 20

2.1 Depth

The third section goes deeper.

Page 30

2.2 Practice

The fourth section applies everything.
`;

function buildFixture(): { digest: DocumentDigest; chunks: PdfChunk[] } {
  const chunks = chunkSourceText(SOURCE, { maxChunkChars: 400 });
  const sections = [
    { heading: '1.1 Introduction', chapter: '1', pageStart: '1', chunkId: chunks.find((c) => c.pageHint === '1')!.id },
    { heading: '1.2 Concepts', chapter: '1', pageStart: '10', chunkId: chunks.find((c) => c.pageHint === '10')!.id },
    { heading: '2.1 Depth', chapter: '2', pageStart: '20', chunkId: chunks.find((c) => c.pageHint === '20')!.id },
    { heading: '2.2 Practice', chapter: '2', pageStart: '30', chunkId: chunks.find((c) => c.pageHint === '30')!.id },
  ];
  return {
    chunks,
    digest: {
      level: 'single',
      totalChars: SOURCE.length,
      sections: sections.map((s, i) => ({
        id: `sec_0${i + 1}`,
        heading: s.heading,
        chapter: s.chapter,
        headings: [s.heading],
        pageStart: s.pageStart,
        pageEnd: s.pageStart,
        teaches: [`topic ${i + 1}`],
        keyTerms: [],
        sourceChunkIds: [s.chunkId],
      })),
    },
  };
}

function outline(retrievalContext: string): SceneOutline {
  return {
    id: 'outline_1',
    title: 'Lesson',
    type: 'slide',
    order: 1,
    description: 'A lesson',
    keyPoints: [],
    retrievalContext,
  } as SceneOutline;
}

describe('collectCitedMarkers', () => {
  test('collects page markers from retrieval context and key points', () => {
    const markers = collectCitedMarkers([
      outline('Retrieved: --- [source p.1] --- text --- [source p.20] --- more'),
      { ...outline(''), keyPoints: ['uses [source p.30]'] } as SceneOutline,
    ]);
    expect(markers).toEqual(new Set(['p.1', 'p.20', 'p.30']));
  });
});

describe('auditDigestCoverage', () => {
  test('sections cited by outlines are covered; the rest become gaps', () => {
    const { digest, chunks } = buildFixture();
    const cited = new Set(['p.1', 'p.30']);
    const result = auditDigestCoverage(digest, chunks, cited);
    expect(result.totalSections).toBe(4);
    expect(result.coveredSections).toBe(2);
    expect(result.coverageRatio).toBe(0.5);
    expect(result.gaps.map((g) => g.heading)).toEqual(['1.2 Concepts', '2.1 Depth']);
    // Chapter 2 still has a cited section (2.2), so it is not uncovered.
    expect(result.uncoveredChapters).toEqual([]);
  });

  test('a chapter with no cited section is flagged', () => {
    const { digest, chunks } = buildFixture();
    const cited = new Set(['p.1']);
    const result = auditDigestCoverage(digest, chunks, cited);
    expect(result.uncoveredChapters).toEqual(['2']);
  });

  test('empty digest yields complete coverage (nothing to cover)', () => {
    const result = auditDigestCoverage(
      { level: 'single', sections: [], totalChars: 0 },
      [],
      new Set(),
    );
    expect(result.coverageRatio).toBe(1);
    expect(result.gaps).toEqual([]);
  });
});

describe('renderCoverageReport', () => {
  test('reports gaps with page anchors and hides nothing', () => {
    const { digest, chunks } = buildFixture();
    const result = auditDigestCoverage(digest, chunks, new Set(['p.1']));
    const report = renderCoverageReport(result);
    expect(report).toContain('1/4');
    expect(report).toContain('1.2 Concepts');
    expect(report).toContain('[p.10]');
  });

  test('full coverage reports the count and no gap list', () => {
    const { digest, chunks } = buildFixture();
    const result = auditDigestCoverage(digest, chunks, new Set(['p.1', 'p.10', 'p.20', 'p.30']));
    const report = renderCoverageReport(result);
    expect(report).toContain('4/4');
    expect(report).not.toContain('not referenced');
  });
});
