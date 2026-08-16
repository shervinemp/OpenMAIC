/**
 * Per-scene source retrieval (Pillar 3b).
 *
 * The outline stage holds the full extracted source text (a ~1000-page PDF
 * cannot survive as one global summary). This module chunks that text,
 * retrieves the top-k chunks relevant to a scene's outline at generation
 * time, and renders them as retrieval context with citation markers so
 * generated slides/quizzes can ground claims in the actual source
 * ("[source p.412]").
 *
 * Pure functions only — no I/O. The chunk index is small enough to rebuild
 * from the outline-stage text in one pass; caching lives in the callers
 * (KV `account`, `maic:pdf-index:{sha256}` — see design §5.3).
 */

// ==================== Types ====================

export interface PdfChunk {
  /** Stable id: sequential index across the whole source. */
  id: string;
  text: string;
  /** Detected page marker (e.g. "412") when the text carried one. */
  pageHint?: string;
  /** Detected heading the chunk starts with, for scoring boosts. */
  heading?: string;
  /** The citation marker rendered for this chunk ("p.412" / "ch.7"). */
  citation: string;
}

export interface ChunkOptions {
  /** Soft maximum chunk size in characters (paragraphs are never split). */
  maxChunkChars?: number;
  /** Skip chunks shorter than this (page-number detritus). */
  minChunkChars?: number;
}

export interface RetrieveOptions {
  topK?: number;
  /** Approximate token budget (4 chars ≈ 1 token). */
  maxTokens?: number;
}

export const DEFAULT_MAX_CHUNK_CHARS = 900;
export const DEFAULT_MIN_CHUNK_CHARS = 40;
export const DEFAULT_TOP_K = 5;
export const DEFAULT_MAX_TOKENS = 2000;
export const CHARS_PER_TOKEN = 4;

// ==================== Chunking ====================

const PAGE_RE = /\b(?:page|p\.)\s*(\d+)\b/i;
const HEADING_RE = /^(?:#{1,6}\s*|\d+(?:\.\d+)*\s+)(.+)$/;

function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.length > 80) return false;
  // Short line that does not end with sentence punctuation and is not a
  // page marker → heading-like (section titles in extracted text).
  if (HEADING_RE.test(trimmed)) return true;
  if (/[.!?;:,]$/.test(trimmed)) return false;
  if (PAGE_RE.test(trimmed)) return false;
  return trimmed.split(/\s+/).length <= 12;
}

/**
 * Chunk extracted source text into paragraph-boundary chunks, tracking
 * page markers and heading lines. Paragraphs are never split; a chunk
 * that would exceed `maxChunkChars` starts a new one.
 */
export function chunkSourceText(text: string, options: ChunkOptions = {}): PdfChunk[] {
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const minChunkChars = options.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;

  const chunks: PdfChunk[] = [];
  let current: string[] = [];
  let currentChars = 0;
  let currentPageHint: string | undefined;
  let currentHeading: string | undefined;
  let chunkIndex = 0;

  const flush = () => {
    const chunkText = current.join('\n').trim();
    const hasFreshHeading = looksLikeHeading(current[0] ?? '') ? current[0]!.trim() : undefined;
    // The page marker continues to apply to content that follows this
    // chunk — retain it across the flush.
    const pageHintToKeep = currentPageHint;
    if (chunkText.length >= minChunkChars) {
      chunkIndex += 1;
      chunks.push({
        id: `chunk_${chunkIndex}`,
        text: chunkText,
        pageHint: currentPageHint,
        heading: hasFreshHeading ?? currentHeading,
        citation: currentPageHint ? `p.${currentPageHint}` : `ch.${chunkIndex}`,
      });
    }
    current = [];
    currentChars = 0;
    currentPageHint = pageHintToKeep;
    currentHeading = hasFreshHeading ?? undefined;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const pageMatch = line.match(PAGE_RE);
    if (pageMatch && line.length <= 60) {
      // A page marker ends the previous page: flush pending content first so
      // each chunk carries ITS OWN page hint (otherwise the heading-flush
      // below would stamp the next page onto the previous chunk).
      if (current.length > 0) flush();
      currentPageHint = pageMatch[1];
      continue;
    }

    if (looksLikeHeading(line) && currentChars > 0) {
      flush();
    }

    current.push(line);
    currentChars += line.length;
    if (currentChars >= maxChunkChars) {
      flush();
    }
  }
  flush();

  return chunks;
}

// ==================== Retrieval ====================

function queryTerms(queryText: string): string[] {
  const terms = new Set<string>();
  for (const word of queryText.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (word.length >= 3) terms.add(word);
  }
  return [...terms];
}

/** Keyword-overlap score between a scene outline query and a chunk. */
export function scoreChunk(queryTerms: string[], chunk: PdfChunk): number {
  let score = 0;
  const text = chunk.text.toLowerCase();
  for (const term of queryTerms) {
    const count = text.split(term).length - 1;
    score += Math.min(count, 3);
  }
  if (chunk.heading) {
    const heading = chunk.heading.toLowerCase();
    for (const term of queryTerms) {
      if (heading.includes(term)) score += 2;
    }
  }
  return score;
}

/** Top-k retrieval with a rough token budget (≈4 chars/token). */
export function retrieveChunks(
  queryText: string,
  chunks: PdfChunk[],
  options: RetrieveOptions = {},
): PdfChunk[] {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  const terms = queryTerms(queryText);
  const ranked = chunks
    .map((chunk) => ({ chunk, score: scoreChunk(terms, chunk) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const selected: PdfChunk[] = [];
  let usedChars = 0;
  for (const entry of ranked) {
    if (selected.length >= topK) break;
    if (usedChars + entry.chunk.text.length > maxChars) continue;
    selected.push(entry.chunk);
    usedChars += entry.chunk.text.length;
  }
  return selected;
}

/**
 * Render retrieved chunks as prompt context. Each chunk is wrapped in
 * blockquotes carrying its citation marker; the citation ground-truth check
 * (validateCitations) verifies generated `[source p.N]` markers against
 * this set.
 */
export function formatRetrievalContext(chunks: PdfChunk[]): string {
  if (chunks.length === 0) return '';
  const blocks = chunks.map(
    (chunk) =>
      `--- [source ${chunk.citation}]${chunk.pageHint ? ` (page ${chunk.pageHint})` : ''} ---\n${chunk.text}`,
  );
  return `Retrieved from the source material (cite these markers verbatim in your content where the claim comes from, e.g. "[source p.412]"):\n${blocks.join('\n\n')}`;
}

// ==================== Citation ground-truth ====================

// PDF chunks cite pages/chapters ("p.412", "ch.7"); web chunks cite source
// indices ("1", "2", ...) — see lib/generation/web-retrieval.ts (§15.2).
const CITATION_RE = /\[source\s+(p\.\d+|ch\.\d+|\d+)\]/gi;

/** Extract citation markers present in generated content. */
export function extractCitationMarkers(text: string): string[] {
  const markers = new Set<string>();
  for (const match of text.matchAll(CITATION_RE)) {
    markers.add(match[1].toLowerCase());
  }
  return [...markers];
}

/**
 * Every citation used in generated content must reference one of the
 * retrieved chunks — a claim citing a page that was never retrieved is a
 * hallucinated citation.
 */
export function validateCitations(
  citedMarkers: string[],
  retrievedChunks: PdfChunk[],
): { valid: boolean; validMarkers: string[]; invalidMarkers: string[] } {
  const validSet = new Set(retrievedChunks.map((chunk) => chunk.citation.toLowerCase()));
  const validMarkers = citedMarkers.filter((marker) => validSet.has(marker));
  const invalidMarkers = citedMarkers.filter((marker) => !validSet.has(marker));
  return { valid: invalidMarkers.length === 0, validMarkers, invalidMarkers };
}
