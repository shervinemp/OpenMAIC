/**
 * Coverage audit (Phase 2 §16).
 *
 * The digest is a map, not the terrain: after the outline stage, this audit
 * compares the blueprint's cited source markers against the document's
 * section/chapter distribution and reports the sections that no lesson
 * cites. Silent loss becomes visible, correctable loss — the caller can
 * gap-fill lessons for uncovered sections or surface the report in the UI.
 *
 * Pure functions only.
 */

import { extractCitationMarkers, type PdfChunk } from './pdf-retrieval';
import type { DocumentDigest, DigestSectionCard } from './document-digest';
import type { SceneOutline } from '@/lib/types/generation';

// ==================== Types ====================

export interface CoverageGap {
  /** Section heading that no outline cites. */
  heading: string;
  chapter: string | null;
  pageStart?: string;
  pageEnd?: string;
}

export interface CoverageAuditResult {
  totalSections: number;
  coveredSections: number;
  /** Sections with zero cited chunks — candidates for gap-fill lessons. */
  gaps: CoverageGap[];
  /** Covered fraction (0-1); 1 when there are no sections to cover. */
  coverageRatio: number;
  /** Chapters (keys) that have no cited section at all. */
  uncoveredChapters: string[];
}

// ==================== Citation collection ====================

/**
 * Collect every citation marker the outlines use, from both the retrieval
 * context ([source p.412] markers) and the outline's own key points (which
 * may cite digest pages directly).
 */
export function collectCitedMarkers(outlines: SceneOutline[]): Set<string> {
  const markers = new Set<string>();
  for (const outline of outlines) {
    const sources = [
      outline.retrievalContext ?? '',
      ...(outline.keyPoints ?? []).filter(Boolean),
    ];
    for (const source of sources) {
      for (const marker of extractCitationMarkers(source)) {
        markers.add(marker.toLowerCase());
      }
    }
  }
  return markers;
}

// ==================== Section coverage ====================

function chunkCitationSet(section: DigestSectionCard, chunks: Map<string, PdfChunk>): Set<string> {
  const citations = new Set<string>();
  for (const id of section.sourceChunkIds) {
    const chunk = chunks.get(id);
    if (!chunk) continue;
    citations.add(chunk.citation.toLowerCase());
    if (chunk.pageHint) citations.add(`p.${chunk.pageHint}`.toLowerCase());
  }
  return citations;
}

/**
 * Audit digest sections against the outline's cited markers. A section is
 * covered when at least one of its chunks' citations (or page hints) was
 * cited by an outline.
 */
export function auditDigestCoverage(
  digest: DocumentDigest,
  chunks: PdfChunk[],
  citedMarkers: Set<string>,
): CoverageAuditResult {
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const sections = digest.sections;
  const gaps: CoverageGap[] = [];
  let covered = 0;

  for (const section of sections) {
    const citations = chunkCitationSet(section, chunksById);
    let cited = false;
    for (const marker of citations) {
      if (citedMarkers.has(marker)) {
        cited = true;
        break;
      }
    }
    if (cited) {
      covered += 1;
    } else {
      gaps.push({
        heading: section.heading,
        chapter: section.chapter,
        pageStart: section.pageStart,
        pageEnd: section.pageEnd,
      });
    }
  }

  const allChapters = new Set<string>();
  const citedChapters = new Set<string>();
  for (const section of sections) {
    if (section.chapter === null) continue;
    allChapters.add(section.chapter);
    const citations = chunkCitationSet(section, chunksById);
    if ([...citations].some((marker) => citedMarkers.has(marker))) {
      citedChapters.add(section.chapter);
    }
  }
  const uncoveredChapters = [...allChapters]
    .filter((chapter) => !citedChapters.has(chapter))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return {
    totalSections: sections.length,
    coveredSections: covered,
    gaps,
    coverageRatio: sections.length === 0 ? 1 : covered / sections.length,
    uncoveredChapters,
  };
}

// ==================== Report rendering ====================

/**
 * Human-readable coverage report for the UI. Empty string when coverage is
 * complete (nothing to flag).
 */
export function renderCoverageReport(result: CoverageAuditResult): string {
  if (result.totalSections === 0) return '';
  if (result.gaps.length === 0) {
    return `Source coverage: ${result.coveredSections}/${result.totalSections} sections cited.`;
  }
  const lines = [
    `Source coverage: ${result.coveredSections}/${result.totalSections} sections cited by the course outline.`,
    'The following sections of your source document are not referenced by any lesson:',
  ];
  for (const gap of result.gaps.slice(0, 8)) {
    const page = gap.pageStart ? ` [p.${gap.pageStart}]` : '';
    const chapter = gap.chapter ? ` (chapter ${gap.chapter})` : '';
    lines.push(`- ${gap.heading}${chapter}${page}`);
  }
  if (result.gaps.length > 8) {
    lines.push(`- …and ${result.gaps.length - 8} more`);
  }
  lines.push('These can be added as lessons (gap-fill) or intentionally excluded.');
  return lines.join('\n');
}
