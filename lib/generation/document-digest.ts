/**
 * Full-document coverage digest (Phase 2 §16).
 *
 * The outline stage decides what a course teaches, so it must see the WHOLE
 * source document — but a 500-page book cannot fit one prompt. This module
 * builds a *coverage map*: enumerative per-section cards (every topic
 * listed, key terms, page anchors), assembled hierarchically so the map
 * always fits the outline prompt's budget.
 *
 * Coverage commitments (no silent loss):
 * - Only extraction noise is stripped — never content paragraphs.
 * - Section cards are enumerative ("list every distinct topic"), not
 *   narrative summaries that select and drop.
 * - Chapters never merge into each other's cards; small sections fold into
 *   their neighbour but keep their headings listed.
 * - The lens pass (buildDigestLensPrompt) may reorder emphasis but must
 *   return a permutation — it can never remove a section.
 * - The full text itself is chunked once (lib/generation/pdf-retrieval.ts)
 *   and retrieved per scene at content time; the digest is only the map.
 *
 * Everything here is either a pure function or takes an injected `aiCall`
 * (no I/O) so the whole flow is unit-testable and the KV cache lives in the
 * callers.
 */

import { tryParseJson } from './json-repair';
import { chunkSourceText, type PdfChunk } from './pdf-retrieval';
import { mapWithConcurrency } from '@/lib/utils/concurrency';
import type { AICallFn } from './pipeline-types';
import {
  DIGEST_BATCH_CHARS,
  DIGEST_LEVEL2_BATCH_CARDS,
  DIGEST_MIN_SECTION_CHARS,
  DIGEST_RAW_THRESHOLD_CHARS,
  DIGEST_TARGET_CHARS,
  LLM_CALL_CONCURRENCY,
} from '@/lib/constants/generation';

// ==================== Types ====================

/** One section's coverage card: enumerative, with page anchors. */
export interface DigestSectionCard {
  /** Stable id, assigned at grouping time (sec_01, sec_02, ...). */
  id: string;
  /** The heading that started the section (may be synthesized). */
  heading: string;
  /** Chapter key detected from the heading ("3" for "3.2 Virtual Memory"). */
  chapter: string | null;
  /** Every heading folded into this card (small-section merge keeps them). */
  headings: string[];
  /** First page hint of the covered range. */
  pageStart?: string;
  /** Last page hint of the covered range. */
  pageEnd?: string;
  /** Enumerative topic entries (1-2 sentences each), never selective. */
  teaches: string[];
  /** All key terms / proper nouns the section introduces. */
  keyTerms: string[];
  /** Chunk ids covered — linkage for the coverage audit. */
  sourceChunkIds: string[];
}

/** Level-2 card: one chapter summarized from its section cards. */
export interface DigestChapterCard {
  /** Stable id (ch_01, ...). */
  id: string;
  chapter: string;
  /** Representative heading (first section heading of the chapter). */
  heading: string;
  pageStart?: string;
  pageEnd?: string;
  /** Every section heading in the chapter, in order — never merged away. */
  sectionHeadings: string[];
  /** Topics merged from all section cards; must not drop any. */
  teaches: string[];
  /** Deduped key terms from all section cards. */
  keyTerms: string[];
}

export interface DocumentDigest {
  level: 'single' | 'two-level';
  /** Level-1 section cards (always computed — ground coverage). */
  sections: DigestSectionCard[];
  /** Level-2 chapter cards (only when section cards exceed the budget). */
  chapters?: DigestChapterCard[];
  /** Total chars of the extracted source text (before noise stripping). */
  totalChars: number;
}

/** A consecutive run of chunks under one heading/chapter. */
export interface DigestSectionGroup {
  id: string;
  chapter: string | null;
  heading: string;
  headings: string[];
  chunks: PdfChunk[];
  charCount: number;
  pageStart?: string;
  pageEnd?: string;
}

export interface DigestBatch {
  index: number;
  groups: DigestSectionGroup[];
}

export interface DigestBuildResult {
  digest: DocumentDigest;
  chunks: PdfChunk[];
  batchCalls: number;
  level: 'raw' | 'single' | 'two-level';
}

export type DigestTier = 'raw' | 'single' | 'two-level';

// ==================== Noise stripping ====================

const PAGE_RANGE_RE = /^\s*(?:page|página|seite|pagina|стор|стp)?\s*\d+\s*(?:of|de|von|из|di|\/)\s*\d+\s*$/i;
const SEPARATOR_RE = /^\s*[-_=~*·•]{3,}\s*$/;
const URL_LINE_RE = /^\s*(?:https?:\/\/|www\.)\S+\s*$/;
const ISBN_RE = /^\s*isbn[:\s]?[\d\s-]{8,}\s*$/i;
const TOC_DOT_LEADER_RE = /^\s*[^.]+\.{4,}\s*\d+\s*$/;
const SHORT_OCR_GARBAGE_RE = /^\s*[A-Za-z0-9\W]{1,2}\s*$/;

function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (PAGE_RANGE_RE.test(trimmed)) return true;
  if (SEPARATOR_RE.test(trimmed)) return true;
  if (URL_LINE_RE.test(trimmed)) return true;
  if (ISBN_RE.test(trimmed)) return true;
  if (TOC_DOT_LEADER_RE.test(trimmed)) return true;
  if (SHORT_OCR_GARBAGE_RE.test(trimmed) && !/[A-Za-z]/.test(trimmed)) return true;
  return false;
}

/**
 * Strip ONLY extraction noise (page headers/footers, separators, URLs,
 * ISBNs, TOC dot leaders, OCR detritus). Never removes content paragraphs,
 * headings, or formulas.
 */
export function stripExtractionNoise(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let repeated = 0;
  let lastLine: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (isNoiseLine(line)) continue;
    if (lastLine !== null && line === lastLine) {
      repeated += 1;
      // Drop long runs of identical lines (scanned headers repeated per
      // page); a short repeat is kept (emphasis or legitimate repetition).
      if (repeated > 2) continue;
    } else {
      repeated = 0;
    }
    kept.push(line);
    lastLine = line;
  }
  return kept.join('\n');
}

// ==================== Structure alignment ====================

const CHAPTER_NUMERIC_RE = /^\s*(?:chapter\s+|ch\.?\s+|section\s+)?(\d+)\b/i;
const CHAPTER_CJK_RE = /^\s*第\s*(\d+)\s*(?:章|节|部分)/;

/** Detect a chapter key from a heading ("3.2 VM" → "3", "第4章" → "4"). */
export function detectChapterKey(heading: string): string | null {
  const trimmed = heading.trim();
  if (!trimmed) return null;
  const numeric = CHAPTER_NUMERIC_RE.exec(trimmed);
  if (numeric) return numeric[1];
  const cjk = CHAPTER_CJK_RE.exec(trimmed);
  if (cjk) return cjk[1];
  return null;
}

/**
 * Group chunks into consecutive structure sections. A chunk whose heading
 * differs from the current section's (or lands in a different chapter)
 * starts a new section; unheaded chunks continue the current one. Sections
 * keep every heading and the full page range for citation anchoring.
 */
export function groupChunksByStructure(chunks: PdfChunk[]): DigestSectionGroup[] {
  const groups: DigestSectionGroup[] = [];
  let current: DigestSectionGroup | null = null;
  let nextId = 0;

  for (const chunk of chunks) {
    const chapter = chunk.heading ? detectChapterKey(chunk.heading) : null;
    const startsSection =
      chunk.heading &&
      (current === null || current.heading !== chunk.heading || current.chapter !== chapter);

    if (startsSection) {
      nextId += 1;
      current = {
        id: `sec_${String(nextId).padStart(2, '0')}`,
        chapter,
        heading: chunk.heading!,
        headings: [chunk.heading!],
        chunks: [chunk],
        charCount: chunk.text.length,
        pageStart: chunk.pageHint,
        pageEnd: chunk.pageHint,
      };
      groups.push(current);
      continue;
    }

    if (current === null) {
      nextId += 1;
      current = {
        id: `sec_${String(nextId).padStart(2, '0')}`,
        chapter: null,
        heading: `Unheaded start (page ${chunk.pageHint ?? '?'})`,
        headings: [],
        chunks: [],
        charCount: 0,
      };
      groups.push(current);
    }

    if (chunk.heading && !current.headings.includes(chunk.heading)) {
      current.headings.push(chunk.heading);
    }
    current.chunks.push(chunk);
    current.charCount += chunk.text.length;
    if (chunk.pageHint) current.pageEnd = chunk.pageHint;
    if (!current.pageStart && chunk.pageHint) current.pageStart = chunk.pageHint;
  }

  return groups;
}

/**
 * Fold sections smaller than `minChars` into the preceding section's card.
 * Their headings are appended (kept in the card) so no topic identity is
 * lost — only the card count shrinks.
 */
export function coalesceSmallSections(
  groups: DigestSectionGroup[],
  minChars: number = DIGEST_MIN_SECTION_CHARS,
): DigestSectionGroup[] {
  if (groups.length < 2) return groups;
  const result: DigestSectionGroup[] = [];
  for (const group of groups) {
    const previous = result[result.length - 1];
    if (previous && group.charCount < minChars) {
      previous.chunks.push(...group.chunks);
      previous.charCount += group.charCount;
      for (const heading of group.headings) {
        if (!previous.headings.includes(heading)) previous.headings.push(heading);
      }
      if (group.pageEnd) previous.pageEnd = group.pageEnd;
      continue;
    }
    result.push({ ...group });
  }
  return result;
}

// ==================== Tier / level planning ====================

/** Estimated card chars for one section (compression ≈ 10:1 + overhead). */
function estimateSectionCardChars(group: DigestSectionGroup): number {
  return Math.min(800, 60 + group.heading.length + Math.round(group.charCount / 10));
}

function estimateSingleLevelChars(groups: DigestSectionGroup[]): number {
  return groups.reduce((sum, group) => sum + estimateSectionCardChars(group), 0);
}

function estimateTwoLevelChars(groups: DigestSectionGroup[]): number {
  const chapters = new Map<string, DigestSectionGroup[]>();
  for (const group of groups) {
    const key = group.chapter ?? 'none';
    const list = chapters.get(key) ?? [];
    list.push(group);
    chapters.set(key, list);
  }
  let total = 0;
  for (const list of chapters.values()) {
    total += 70 + list.reduce((sum, group) => sum + group.heading.length + 55, 0);
  }
  return total;
}

/** Whether the outline stage reads raw text (small docs) or a digest. */
export function resolveDigestTier(totalChars: number): 'raw' | 'digest' {
  return totalChars <= DIGEST_RAW_THRESHOLD_CHARS ? 'raw' : 'digest';
}

/**
 * Plan the digest level from the structure groups: single-level (section
 * cards fit the budget) or two-level (chapter cards instead).
 */
export function planDigestLevel(
  groups: DigestSectionGroup[],
  budgetChars: number = DIGEST_TARGET_CHARS,
): 'single' | 'two-level' {
  if (estimateSingleLevelChars(groups) <= budgetChars) return 'single';
  return estimateTwoLevelChars(groups) <= budgetChars ? 'two-level' : 'two-level';
}

/**
 * Pack groups into batches ≤ batchChars. A section is never split unless it
 * alone exceeds the batch budget (then it is split with continuation marks;
 * cards merge back on the section id).
 */
export function planDigestBatches(
  groups: DigestSectionGroup[],
  batchChars: number = DIGEST_BATCH_CHARS,
): DigestBatch[] {
  const batches: DigestBatch[] = [];
  let current: DigestSectionGroup[] = [];
  let currentChars = 0;
  let batchIndex = 0;

  const flush = () => {
    if (current.length === 0) return;
    batches.push({ index: batchIndex, groups: current });
    batchIndex += 1;
    current = [];
    currentChars = 0;
  };

  const pack = (group: DigestSectionGroup) => {
    if (currentChars + group.charCount > batchChars && current.length > 0) flush();
    current.push(group);
    currentChars += group.charCount;
  };

  for (const group of groups) {
    if (group.charCount <= batchChars) {
      pack(group);
      continue;
    }

    // Oversized section: split its chunk run into sub-groups that share the
    // section id (cards merge back on the id), then pack them normally.
    let run: PdfChunk[] = [];
    let runChars = 0;
    let splitIndex = 0;
    for (const chunk of group.chunks) {
      if (runChars + chunk.text.length > batchChars && run.length > 0) {
        pack({
          ...group,
          chunks: run,
          charCount: runChars,
          headings: splitIndex === 0 ? group.headings : [],
          heading: splitIndex === 0 ? group.heading : `${group.heading} (cont.)`,
          pageStart: run[0]?.pageHint,
          pageEnd: run[run.length - 1]?.pageHint,
        });
        splitIndex += 1;
        run = [];
        runChars = 0;
      }
      run.push(chunk);
      runChars += chunk.text.length;
    }
    if (run.length > 0) {
      pack({
        ...group,
        chunks: run,
        charCount: runChars,
        headings: splitIndex === 0 ? group.headings : [],
        heading: splitIndex === 0 ? group.heading : `${group.heading} (cont.)`,
        pageStart: run[0]?.pageHint,
        pageEnd: run[run.length - 1]?.pageHint,
      });
    }
  }
  flush();
  return batches;
}

// ==================== Prompts ====================

function pageRangeLabel(group: Pick<DigestSectionGroup, 'pageStart' | 'pageEnd'>): string {
  const start = group.pageStart ?? '?';
  const end = group.pageEnd ?? start;
  return start === end ? `page ${start}` : `pages ${start}–${end}`;
}

/**
 * Level-1 prompt: enumerate EVERY topic of the section. The contract word
 * is "every distinct topic" — selection is a failure, not a feature.
 */
export function buildDigestSectionPrompt(
  group: DigestSectionGroup,
  language: string = 'English',
): { system: string; user: string } {
  const headingLine = group.headings.length > 0 ? group.headings.join(' / ') : group.heading;
  const sourceText = group.chunks.map((chunk) => chunk.text).join('\n\n---\n\n');
  return {
    system: [
      'You are a document indexer building a coverage map for course generation.',
      'For the given section of a source document, enumerate EVERY distinct topic the text teaches.',
      'Do not select, prioritize, or drop any topic because it seems minor — completeness is the contract.',
      'Include ALL key terms, proper nouns, and technical identifiers introduced.',
      'Write 1-2 sentences per topic. Never invent content that is not in the text.',
      `Respond in ${language}.`,
      'Respond ONLY with JSON: {"teaches": ["..."], "keyTerms": ["..."]}',
    ].join('\n'),
    user: [
      '## Section',
      `Heading(s): ${headingLine}`,
      `Range: ${pageRangeLabel(group)}`,
      '',
      '## Source text',
      sourceText,
    ].join('\n'),
  };
}

export interface ParsedDigestSection {
  teaches: string[];
  keyTerms: string[];
}

/** Parse + validate a level-1 section card response. Null on garbage. */
export function parseDigestSectionResponse(text: string): ParsedDigestSection | null {
  const parsed = tryParseJson<{ teaches?: unknown; keyTerms?: unknown }>(text);
  if (!parsed || typeof parsed !== 'object') return null;
  const teaches = Array.isArray(parsed.teaches)
    ? parsed.teaches.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim())
    : [];
  const keyTerms = Array.isArray(parsed.keyTerms)
    ? parsed.keyTerms.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim())
    : [];
  if (teaches.length === 0 && keyTerms.length === 0) return null;
  return { teaches, keyTerms };
}

/** Merge split/continuation cards for the same section id. */
export function mergeSectionCards(cards: ParsedDigestSection[]): ParsedDigestSection {
  const teaches: string[] = [];
  const keyTerms: string[] = [];
  for (const card of cards) {
    for (const entry of card.teaches) {
      if (!teaches.includes(entry)) teaches.push(entry);
    }
    for (const term of card.keyTerms) {
      if (!keyTerms.includes(term)) keyTerms.push(term);
    }
  }
  return { teaches, keyTerms };
}

/**
 * Level-2 prompt: merge section cards into one chapter card. MUST NOT drop
 * topics — the prompt forbids it and section headings stay enumerable.
 */
export function buildChapterCardPrompt(
  chapterKey: string,
  cards: DigestSectionCard[],
  language: string = 'English',
): { system: string; user: string } {
  const sections = cards
    .map((card) => {
      const lines = [`### ${card.heading}${card.pageStart ? ` [p.${card.pageStart}]` : ''}`];
      for (const entry of card.teaches) lines.push(`- ${entry}`);
      if (card.keyTerms.length > 0) lines.push(`Terms: ${card.keyTerms.join(', ')}`);
      return lines.join('\n');
    })
    .join('\n\n');
  return {
    system: [
      'You are merging section coverage cards into one chapter card for a document coverage map.',
      'MUST NOT DROP ANY TOPIC: every topic from every section card must remain represented in the merged card.',
      'Merge duplicate topics and deduplicate key terms; keep wording concise.',
      `Respond in ${language}.`,
      'Respond ONLY with JSON: {"teaches": ["..."], "keyTerms": ["..."]}',
    ].join('\n'),
    user: [`## Chapter ${chapterKey}`, sections].join('\n\n'),
  };
}

export function parseChapterCardResponse(text: string): ParsedDigestSection | null {
  return parseDigestSectionResponse(text);
}

// ==================== Rendering ====================

export interface DigestRenderOptions {
  /** Hard render budget; when exceeded, topics are trimmed proportionally
   *  and the trim count is reported — never silently dropped. */
  maxChars?: number;
}

export interface DigestRenderResult {
  text: string;
  trimmedTopics: number;
}

function renderSections(
  sections: Array<{ heading: string; pageStart?: string; pageEnd?: string; teaches: string[]; keyTerms: string[] }>,
  levelLabel: string,
): { text: string; topicCount: number } {
  const topicCount = sections.reduce((sum, section) => sum + section.teaches.length, 0);
  const lines: string[] = [
    '## Source Document Coverage Map',
    `${levelLabel} — ${sections.length} sections. Page anchors are citable as "[source p.N]".`,
    '',
  ];
  for (const section of sections) {
    const anchor =
      section.pageStart || section.pageEnd
        ? ` [source p.${section.pageStart ?? section.pageEnd}]`
        : '';
    lines.push(`### ${section.heading}${anchor}`);
    for (const entry of section.teaches) lines.push(`- ${entry}`);
    if (section.keyTerms.length > 0) {
      lines.push(`Key terms: ${section.keyTerms.join(', ')}`);
    }
    lines.push('');
  }
  return { text: lines.join('\n'), topicCount };
}

/**
 * Render the coverage map for the outline prompt. Two-level digests render
 * chapter cards (every section heading still enumerated). When the render
 * budget is exceeded, topic entries are dropped proportionally from the
 * largest sections and the trim count is reported — callers surface it.
 */
export function renderDocumentDigest(
  digest: DocumentDigest,
  options: DigestRenderOptions = {},
): DigestRenderResult {
  const maxChars = options.maxChars ?? DIGEST_TARGET_CHARS;

  const buildText = (): { text: string; topicCount: number } => {
    if (digest.level === 'two-level' && digest.chapters && digest.chapters.length > 0) {
      const sections = digest.chapters.map((chapter) => ({
        heading: `${chapter.heading} (sections: ${chapter.sectionHeadings.join('; ')})`,
        pageStart: chapter.pageStart,
        pageEnd: chapter.pageEnd,
        teaches: chapter.teaches,
        keyTerms: chapter.keyTerms,
      }));
      return renderSections(sections, 'two-level');
    }
    return renderSections(
      digest.sections.map((section) => ({
        heading: section.heading,
        pageStart: section.pageStart,
        pageEnd: section.pageEnd,
        teaches: section.teaches,
        keyTerms: section.keyTerms,
      })),
      digest.level,
    );
  };

  const rendered = buildText();
  if (rendered.text.length <= maxChars) {
    return { text: rendered.text, trimmedTopics: 0 };
  }

  // Proportional trim: repeatedly drop one topic from the currently largest
  // card until the budget fits. Deterministic; reported, not silent.
  const cards = digest.level === 'two-level' && digest.chapters
    ? digest.chapters.map((c) => ({ teaches: c.teaches }))
    : digest.sections.map((s) => ({ teaches: s.teaches }));
  let trimmed = 0;
  let current = rendered.text;
  while (current.length > maxChars) {
    let largest: { teaches: string[] } | null = null;
    for (const card of cards) {
      if (card.teaches.length > 0 && (!largest || card.teaches.length > largest.teaches.length)) {
        largest = card;
      }
    }
    if (!largest) break;
    largest.teaches.pop();
    trimmed += 1;
    current = buildText().text;
  }
  return { text: current, trimmedTopics: trimmed };
}

// ==================== Lens (emphasis ordering, never removal) ====================

/**
 * Lens prompt: reorder the coverage map toward the course requirement.
 * The contract requires a full permutation of the indices — the lens may
 * reprioritize but can never delete coverage.
 */
export function buildDigestLensPrompt(
  requirement: string,
  contractText: string,
  digestText: string,
  language: string = 'English',
): { system: string; user: string } {
  const indices = digestText
    .split('\n')
    .filter((line) => /^###\s/.test(line))
    .map((line) => line.replace(/^###\s+/, '').slice(0, 60));
  return {
    system: [
      'You are ordering a document coverage map by relevance to a course requirement.',
      'The input sections are numbered. Output the COMPLETE ordered list of ALL section numbers,',
      'most relevant first. This is a permutation — you MUST include every number exactly once.',
      'Sections whose relevance you cannot judge keep their original relative order at the end.',
      `Respond in ${language}. Respond ONLY with JSON: {"order": [0, 1, 2, ...]}`,
    ].join('\n'),
    user: [
      '## Course requirement',
      requirement,
      '',
      '## Course contract',
      contractText || '(default contract)',
      '',
      '## Coverage map sections',
      indices.map((heading, i) => `${i}. ${heading}`).join('\n'),
    ].join('\n'),
  };
}

/** Parse the lens order; must be a full permutation, else null (no reorder). */
export function parseLensOrder(text: string, count: number): number[] | null {
  const parsed = tryParseJson<{ order?: unknown }>(text);
  const order = Array.isArray(parsed?.order)
    ? parsed.order.filter((n): n is number => typeof n === 'number')
    : [];
  if (order.length !== count) return null;
  const seen = new Set<number>();
  for (const n of order) {
    if (!Number.isInteger(n) || n < 0 || n >= count || seen.has(n)) return null;
    seen.add(n);
  }
  return order;
}

/** Reorder a digest's cards by the lens permutation. */
export function applyLensOrder(digest: DocumentDigest, order: number[]): DocumentDigest {
  if (digest.level === 'two-level' && digest.chapters && order.length === digest.chapters.length) {
    const reordered = order.map((index) => digest.chapters![index]);
    return { ...digest, chapters: reordered };
  }
  if (order.length === digest.sections.length) {
    const reordered = order.map((index) => digest.sections[index]);
    return { ...digest, sections: reordered };
  }
  return digest;
}

// ==================== Orchestrator ====================

export interface BuildDigestOptions {
  /** Outline-prompt render budget. */
  targetChars?: number;
  /** Course language for the digest. */
  language?: string;
  /** Called for every batch (level-1 and level-2). Injected — no I/O here. */
  aiCall: AICallFn;
  onProgress?: (phase: 'digest', done: number, total: number) => void;
}

/**
 * Build the coverage digest for an extracted source text. Pure w.r.t. I/O:
 * the LLM calls go through the injected `aiCall`; caching lives in callers.
 */
export async function buildDocumentDigest(
  rawText: string,
  options: BuildDigestOptions,
): Promise<DigestBuildResult> {
  const targetChars = options.targetChars ?? DIGEST_TARGET_CHARS;
  const language = options.language ?? 'English';
  const totalChars = rawText.length;

  const cleaned = stripExtractionNoise(rawText);
  const chunks = chunkSourceText(cleaned);

  if (totalChars <= DIGEST_RAW_THRESHOLD_CHARS) {
    return {
      digest: { level: 'single', sections: [], totalChars },
      chunks,
      batchCalls: 0,
      level: 'raw',
    };
  }

  const groups = coalesceSmallSections(groupChunksByStructure(chunks));
  const level = planDigestLevel(groups, targetChars);
  const batches = planDigestBatches(groups);

  // Level 1: section cards. The per-group LLM calls are independent, so run
  // them with bounded concurrency — a 16-chapter book's cards otherwise
  // serialize into a long indexing pass.
  const cardsBySection = new Map<string, ParsedDigestSection[]>();
  let batchCalls = 0;

  const groupJobs: DigestSectionGroup[] = [];
  for (const batch of batches) {
    for (const group of batch.groups) groupJobs.push(group);
  }

  const results = await mapWithConcurrency(groupJobs, LLM_CALL_CONCURRENCY, async (group) => {
    const prompt = buildDigestSectionPrompt(group, language);
    const response = await options.aiCall(prompt.system, prompt.user);
    // Incremental progress: report as each section card lands (not only after
    // the whole parallel batch finishes) so a long digest stays visibly alive.
    batchCalls += 1;
    options.onProgress?.('digest', batchCalls, groupJobs.length);
    return { groupId: group.id, card: parseDigestSectionResponse(response) };
  });
  for (const result of results) {
    if (!result) continue;
    const { groupId, card } = result;
    if (!card) continue;
    const list = cardsBySection.get(groupId) ?? [];
    list.push(card);
    cardsBySection.set(groupId, list);
  }

  const sections: DigestSectionCard[] = [];
  const groupById = new Map(groups.map((group) => [group.id, group]));
  for (const [id, cards] of cardsBySection.entries()) {
    const group = groupById.get(id);
    if (!group) continue;
    const merged = mergeSectionCards(cards);
    sections.push({
      id,
      heading: group.heading,
      chapter: group.chapter,
      headings: group.headings,
      pageStart: group.pageStart,
      pageEnd: group.pageEnd,
      teaches: merged.teaches,
      keyTerms: merged.keyTerms,
      sourceChunkIds: group.chunks.map((chunk) => chunk.id),
    });
  }
  sections.sort((a, b) => a.id.localeCompare(b.id));

  if (level !== 'two-level') {
    return {
      digest: { level: 'single', sections, totalChars },
      chunks,
      batchCalls,
      level: 'single',
    };
  }

  // Level 2: chapter cards (merge, never drop).
  const byChapter = new Map<string, DigestSectionCard[]>();
  for (const section of sections) {
    const key = section.chapter ?? 'none';
    const list = byChapter.get(key) ?? [];
    list.push(section);
    byChapter.set(key, list);
  }

  const chapterEntries = Array.from(byChapter.entries()).sort(([a], [b]) => a.localeCompare(b));
  const chapterBatches: Array<Array<[string, DigestSectionCard[]]>> = [];
  for (let i = 0; i < chapterEntries.length; i += DIGEST_LEVEL2_BATCH_CARDS) {
    chapterBatches.push(chapterEntries.slice(i, i + DIGEST_LEVEL2_BATCH_CARDS));
  }

  const chapters: DigestChapterCard[] = [];
  for (const [batchIndex, batch] of chapterBatches.entries()) {
    for (const [chapterKey, cards] of batch) {
      const prompt = buildChapterCardPrompt(chapterKey, cards, language);
      const response = await options.aiCall(prompt.system, prompt.user);
      const card = parseChapterCardResponse(response);
      if (!card) continue;
      chapters.push({
        id: `ch_${String(batchIndex + 1).padStart(2, '0')}`,
        chapter: chapterKey,
        heading: cards[0]?.heading ?? `Chapter ${chapterKey}`,
        pageStart: cards[0]?.pageStart,
        pageEnd: cards[cards.length - 1]?.pageEnd ?? cards[0]?.pageEnd,
        sectionHeadings: cards.map((c) => c.heading),
        teaches: card.teaches,
        keyTerms: card.keyTerms,
      });
      batchCalls += 1;
    }
  }

  return {
    digest: { level: 'two-level', sections, chapters, totalChars },
    chunks,
    batchCalls,
    level: 'two-level',
  };
}
