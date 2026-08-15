import { describe, expect, test } from 'vitest';
import {
  chunkSourceText,
  extractCitationMarkers,
  formatRetrievalContext,
  retrieveChunks,
  scoreChunk,
  validateCitations,
} from '@/lib/generation/pdf-retrieval';

const SOURCE = `Page 1

Introduction to Delta Lake

Delta Lake is an open-source storage framework that brings ACID transactions
to data lakes. It enables reliable data engineering at scale on top of object
storage such as S3.

Page 2

Medallion Architecture

A medallion architecture organizes data into bronze, silver, and gold layers.
The bronze layer keeps raw ingested data unchanged so that reprocessing is
always possible from the original records.

The silver layer cleans and deduplicates records and enforces schema checks.

Page 3

Gold layer tables are curated for business consumption and analytics.

Delta Live Tables

Delta Live Tables (DLT) declares a pipeline of tables and lets the runtime
manage dependency resolution and refresh scheduling for the whole pipeline.
`;

describe('chunkSourceText', () => {
  test('splits into paragraph-boundary chunks with page hints', () => {
    const chunks = chunkSourceText(SOURCE, { maxChunkChars: 220 });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
    // The chunk containing DLT text should carry a page hint.
    const dlt = chunks.find((c) => c.text.includes('Delta Live Tables (DLT)'));
    expect(dlt).toBeDefined();
    expect(dlt!.pageHint).toBe('3');
    expect(dlt!.citation).toBe('p.3');
  });

  test('falls back to chunk-index citations without page markers', () => {
    const chunks = chunkSourceText('First paragraph of text here.\n\nSecond paragraph of text here.');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.every((c) => c.citation.startsWith('ch.'))).toBe(true);
  });

  test('drops page-marker detritus', () => {
    const chunks = chunkSourceText('Page 42', { minChunkChars: 40 });
    expect(chunks).toHaveLength(0);
  });
});

describe('retrieval', () => {
  const chunks = chunkSourceText(SOURCE);

  test('ranks chunks by keyword overlap against the outline query', () => {
    const query = 'Delta Live Tables pipeline dependency resolution';
    const retrieved = retrieveChunks(query, chunks, { topK: 3 });
    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved[0].text).toContain('Delta Live Tables');
  });

  test('returns nothing for an unrelated query', () => {
    const retrieved = retrieveChunks('zebra migration patterns in antarctica', chunks);
    expect(retrieved).toHaveLength(0);
  });

  test('scoreChunk boosts heading matches', () => {
    const headingChunk = {
      id: 'c1',
      text: 'The medallion layers hold bronze and silver data.',
      heading: 'Medallion Architecture',
      citation: 'ch.1',
    };
    const bodyChunk = {
      id: 'c2',
      text: 'The medallion layers hold bronze and silver data.',
      citation: 'ch.2',
    };
    expect(scoreChunk(['medallion'], headingChunk)).toBeGreaterThan(
      scoreChunk(['medallion'], bodyChunk),
    );
  });
});

describe('citations', () => {
  test('formatRetrievalContext renders markers per chunk', () => {
    const chunks = chunkSourceText(SOURCE).filter((c) => c.pageHint);
    const context = formatRetrievalContext(chunks);
    expect(context).toContain('[source p.');
    expect(context).toContain('--- [source');
  });

  test('extractCitationMarkers finds p.N and ch.N markers', () => {
    const text = 'Claim one [source p.2]. Claim two [source ch.7].';
    expect(extractCitationMarkers(text).sort()).toEqual(['ch.7', 'p.2']);
  });

  test('validateCitations rejects markers outside the retrieved set', () => {
    const chunks = chunkSourceText(SOURCE).filter((c) => c.pageHint === '2');
    const result = validateCitations(['p.2', 'p.99'], chunks);
    expect(result.valid).toBe(false);
    expect(result.validMarkers).toEqual(['p.2']);
    expect(result.invalidMarkers).toEqual(['p.99']);
  });
});
