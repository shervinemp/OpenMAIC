/**
 * Web research retrieval (Phase 2 §15.2).
 *
 * Title-only (or web-research-enabled) courses ground their scenes the same
 * way PDF courses do: search results are chunked with the shared paragraph
 * chunker, retrieved per scene at the outline stage, and rendered as
 * retrieval context whose citations are the source indices — "[source 1]",
 * "[source 2]" — mapped to the search result list. The citation
 * ground-truth check (validateCitations) works unchanged because the
 * markers are embedded in the retrieval context itself.
 *
 * Pure functions only; the search itself lives in the callers
 * (lib/web-search, called per unit by the multi-unit outline route).
 */

import { chunkSourceText, type PdfChunk } from './pdf-retrieval';
import type { WebSearchResult } from '@/lib/types/web-search';

/**
 * Chunk a search result into retrievable chunks. Each chunk carries the
 * 1-based source index as its citation marker and the source title as its
 * heading (heading matches score higher).
 */
export function webSourcesToChunks(result: WebSearchResult): PdfChunk[] {
  const chunks: PdfChunk[] = [];
  result.sources.forEach((source, index) => {
    const citation = `${index + 1}`;
    for (const chunk of chunkSourceText(source.content)) {
      chunks.push({
        ...chunk,
        id: `web_${citation}_${chunk.id}`,
        heading: chunk.heading ?? source.title,
        citation,
      });
    }
  });
  return chunks;
}

/**
 * Render the citation legend for a search result: which source each
 * "[source N]" marker refers to. Prepended to the unit research context so
 * the model (and later the user) can trace claims back to URLs.
 */
export function formatWebSourceLegend(result: WebSearchResult): string {
  if (result.sources.length === 0) return '';
  const lines = result.sources.map(
    (source, index) => `${index + 1}. ${source.title} — ${source.url}`,
  );
  return `Web sources (cite as "[source N]" using these numbers):\n${lines.join('\n')}`;
}
