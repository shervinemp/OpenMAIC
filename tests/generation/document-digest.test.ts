import { describe, expect, test } from 'vitest';
import {
  applyLensOrder,
  buildChapterCardPrompt,
  buildDigestBatchPrompt,
  buildDigestLensPrompt,
  buildDigestSectionPrompt,
  buildDocumentDigest,
  coalesceSmallSections,
  detectChapterKey,
  groupChunksByStructure,
  mergeSectionCards,
  parseChapterCardResponse,
  parseDigestBatchResponse,
  parseDigestSectionResponse,
  parseLensOrder,
  planDigestBatches,
  planDigestLevel,
  renderDocumentDigest,
  resolveDigestTier,
  stripExtractionNoise,
  type DigestSectionCard,
} from '@/lib/generation/document-digest';
import { chunkSourceText } from '@/lib/generation/pdf-retrieval';
import { DIGEST_BATCH_CHARS, DIGEST_RAW_THRESHOLD_CHARS, DIGEST_TARGET_CHARS } from '@/lib/constants/generation';

// ~26k chars of textbook-shaped source: chapters 1-3, each with sections.
const CHAPTER = (n: number, sections: Array<[string, string]>) => {
  const body = sections
    .map(
      ([heading, text], i) =>
        `${n}.${i + 1} ${heading}\n\n${text}\n\n${'supporting detail for the topic above, expanding the definition with examples and edge cases. '.repeat(20)}`,
    )
    .join('\n');
  return `Chapter ${n} Overview\n\n${body}\n`;
};

const SOURCE =
  CHAPTER(1, [
    ['Introduction', 'Chapter one introduces the field and its history.'],
    ['Core Concepts', 'This section defines the core concepts and vocabulary.'],
    ['Early Systems', 'Early systems laid the groundwork with limited scope.'],
  ]) +
  CHAPTER(2, [
    ['Foundations', 'Chapter two builds the foundations in depth.'],
    ['The Middle Layer', 'The middle layer connects foundations to applications.'],
    ['Advanced Topics', 'Advanced topics cover the harder material.'],
  ]) +
  CHAPTER(3, [
    ['Putting It Together', 'Chapter three integrates everything into practice.'],
    ['Case Studies', 'Case studies show real deployments and failures.'],
    ['Open Problems', 'Open problems round out the field with research directions.'],
  ]);

function chapterChunks(text: string) {
  return chunkSourceText(text, { maxChunkChars: 900 });
}

describe('stripExtractionNoise', () => {
  test('removes page headers, separators, URLs, ISBN, TOC leaders, OCR junk', () => {
    const noisy = [
      'Page 3 of 120',
      '----',
      'Real content paragraph that must survive.',
      'https://example.com/footer',
      'ISBN 978-0-13-468599-1',
      'Chapter 1 ............ 12',
      '++',
      '',
    ].join('\n');
    const cleaned = stripExtractionNoise(noisy);
    expect(cleaned).toContain('Real content paragraph that must survive.');
    expect(cleaned).not.toContain('Page 3 of 120');
    expect(cleaned).not.toContain('----');
    expect(cleaned).not.toContain('https://example.com');
    expect(cleaned).not.toContain('ISBN');
    expect(cleaned).not.toContain('............');
    expect(cleaned).not.toContain('++');
  });

  test('keeps formulas and content lines untouched', () => {
    const content = 'The entropy is H(X) = -Σ p(x) log p(x).';
    expect(stripExtractionNoise(content)).toContain('H(X)');
  });
});

describe('detectChapterKey', () => {
  test('numeric and named chapters', () => {
    expect(detectChapterKey('3.2 Virtual Memory')).toBe('3');
    expect(detectChapterKey('Chapter 4 — Paging')).toBe('4');
    expect(detectChapterKey('12 Conclusion')).toBe('12');
    expect(detectChapterKey('第4章 内存管理')).toBe('4');
    expect(detectChapterKey('Appendices and Index')).toBeNull();
  });
});

describe('groupChunksByStructure', () => {
  test('sections carry chapter identity, page range, and all chunks', () => {
    const groups = groupChunksByStructure(chapterChunks(SOURCE));
    expect(groups.length).toBeGreaterThanOrEqual(9);
    const chapterGroups = groups.filter((g) => g.chapter === '2');
    expect(chapterGroups.length).toBeGreaterThanOrEqual(3);
    for (const group of chapterGroups) {
      expect(group.charCount).toBeGreaterThan(0);
      expect(group.chunks.map((c) => c.id)).toHaveLength(group.chunks.length);
    }
  });

  test('coalescing folds small sections but keeps their headings', () => {
    const groups = groupChunksByStructure(chapterChunks(SOURCE));
    const before = groups.length;
    const coalesced = coalesceSmallSections(groups, 700);
    expect(coalesced.length).toBeLessThanOrEqual(before);
    const totalHeadings = coalesced.reduce((sum, g) => sum + g.headings.length, 0);
    const originalHeadings = groups.reduce((sum, g) => sum + g.headings.length, 0);
    expect(totalHeadings).toBe(originalHeadings);
  });
});

describe('resolveDigestTier / planDigestLevel', () => {
  test('small documents resolve to raw tier', () => {
    expect(resolveDigestTier(5_000)).toBe('raw');
    expect(resolveDigestTier(DIGEST_RAW_THRESHOLD_CHARS)).toBe('raw');
    expect(resolveDigestTier(DIGEST_RAW_THRESHOLD_CHARS + 1)).toBe('digest');
  });

  test('large documents plan two-level when single would exceed the budget', () => {
    const groups = groupChunksByStructure(chapterChunks(SOURCE));
    // 26k chars → single-level cards ≈ 9 * 300 ≈ 2.7k chars < 16k budget.
    expect(planDigestLevel(groups, DIGEST_TARGET_CHARS)).toBe('single');
    const huge = Array.from({ length: 60 }, (_, i) => ({
      id: `sec_${i}`,
      chapter: String(i % 10),
      heading: `${i}.1 A long section heading number ${i}`,
      headings: [`${i}.1 A long section heading number ${i}`],
      chunks: [] as never[],
      charCount: 6_000,
    }));
    expect(planDigestLevel(huge, DIGEST_TARGET_CHARS)).toBe('two-level');
  });
});

describe('planDigestBatches', () => {
  test('packs groups within the batch budget and never splits sections', () => {
    const groups = groupChunksByStructure(chapterChunks(SOURCE));
    const batches = planDigestBatches(groups, DIGEST_BATCH_CHARS);
    for (const batch of batches) {
      const total = batch.groups.reduce((sum, g) => sum + g.charCount, 0);
      expect(total).toBeLessThanOrEqual(DIGEST_BATCH_CHARS + 900);
    }
    const packedGroups = batches.flatMap((b) => b.groups);
    expect(packedGroups.length).toBeGreaterThanOrEqual(groups.length);
  });

  test('splits an oversized section and merges cards back by id', () => {
    const chunks = chapterChunks(SOURCE);
    const oversized = [
      {
        id: 'sec_01',
        chapter: '1',
        heading: '1.1 Huge Section',
        headings: ['1.1 Huge Section'],
        chunks,
        charCount: chunks.reduce((sum, c) => sum + c.text.length, 0),
      },
    ];
    const batches = planDigestBatches(oversized, DIGEST_BATCH_CHARS);
    expect(batches.length).toBeGreaterThan(1);
    const merged = mergeSectionCards([
      { teaches: ['a'], keyTerms: ['x'] },
      { teaches: ['b', 'a'], keyTerms: ['y', 'x'] },
    ]);
    expect(merged.teaches).toEqual(['a', 'b']);
    expect(merged.keyTerms).toEqual(['x', 'y']);
  });
});

describe('digest prompts and parsing', () => {
  test('section prompt enumerates headings, page range, and full text', () => {
    const groups = groupChunksByStructure(chapterChunks(SOURCE));
    const prompt = buildDigestSectionPrompt(groups[0], 'English');
    expect(prompt.user).toContain(groups[0].heading);
    expect(prompt.user).toContain(groups[0].chunks[0].text.slice(0, 40));
    expect(prompt.system).toContain('EVERY distinct topic');
  });

  test('parses valid responses and rejects garbage', () => {
    expect(parseDigestSectionResponse('{"teaches":["a","b"],"keyTerms":["k"]}')).toEqual({
      teaches: ['a', 'b'],
      keyTerms: ['k'],
    });
    expect(parseDigestSectionResponse('not json')).toBeNull();
    expect(parseDigestSectionResponse('{"teaches":[1,2]}')).toBeNull();
  });

  test('batch prompt lists every section by id and the parser maps them back', () => {
    const groups = groupChunksByStructure(chapterChunks(SOURCE));
    const batch = groups.slice(0, 2);
    const prompt = buildDigestBatchPrompt(batch, 'English');
    for (const group of batch) {
      expect(prompt.user).toContain(`### SECTION ${group.id}`);
      expect(prompt.user).toContain(group.heading);
    }
    expect(prompt.system).toContain('"sections"');

    const ids = batch.map((group) => group.id);
    const parsed = parseDigestBatchResponse(
      JSON.stringify({
        sections: {
          [ids[0]]: { teaches: ['a'], keyTerms: ['k'] },
          [ids[1]]: { teaches: ['b'], keyTerms: ['j'] },
          sec_zz: { teaches: ['ignored'], keyTerms: [] },
        },
      }),
      ids,
    );
    expect(parsed.size).toBe(2);
    expect(parsed.get(ids[0])!.teaches).toEqual(['a']);
    expect(parsed.get(ids[1])!.teaches).toEqual(['b']);
    expect(parseDigestBatchResponse('not json', ids).size).toBe(0);
  });

  test('chapter prompt forbids dropping topics and lists every section', () => {
    const cards: DigestSectionCard[] = [
      {
        id: 'sec_01',
        heading: '2.1 Foundations',
        chapter: '2',
        headings: ['2.1 Foundations'],
        pageStart: '10',
        teaches: ['topic one'],
        keyTerms: ['term-a'],
        sourceChunkIds: ['chunk_1'],
      },
      {
        id: 'sec_02',
        heading: '2.2 Advanced',
        chapter: '2',
        headings: ['2.2 Advanced'],
        teaches: ['topic two'],
        keyTerms: ['term-b'],
        sourceChunkIds: ['chunk_2'],
      },
    ];
    const prompt = buildChapterCardPrompt('2', cards, 'English');
    expect(prompt.system).toContain('MUST NOT DROP ANY TOPIC');
    expect(prompt.user).toContain('2.1 Foundations');
    expect(prompt.user).toContain('2.2 Advanced');
    expect(parseChapterCardResponse('{"teaches":["m"],"keyTerms":["t"]}')).not.toBeNull();
  });
});

describe('renderDocumentDigest', () => {
  const digest = {
    level: 'single' as const,
    sections: [
      {
        id: 'sec_01',
        heading: '3.1 Putting It Together',
        chapter: '3',
        headings: ['3.1 Putting It Together'],
        pageStart: '41',
        pageEnd: '44',
        teaches: ['Topic A', 'Topic B', 'Topic C', 'Topic D'],
        keyTerms: ['integration'],
        sourceChunkIds: ['chunk_1'],
      },
    ],
    totalChars: 20_000,
  };

  test('renders coverage map with citable page anchors', () => {
    const rendered = renderDocumentDigest(digest);
    expect(rendered.text).toContain('Source Document Coverage Map');
    expect(rendered.text).toContain('[source p.41]');
    expect(rendered.text).toContain('Topic A');
    expect(rendered.trimmedTopics).toBe(0);
  });

  test('budget trim drops topics proportionally and reports the count', () => {
    const rendered = renderDocumentDigest(digest, { maxChars: 60 });
    expect(rendered.text.length).toBeLessThanOrEqual(200);
    expect(rendered.trimmedTopics).toBeGreaterThan(0);
  });

  test('two-level render enumerates every section heading', () => {
    const twoLevel = {
      level: 'two-level' as const,
      sections: digest.sections,
      chapters: [
        {
          id: 'ch_01',
          chapter: '3',
          heading: '3.1 Putting It Together',
          sectionHeadings: ['3.1 Putting It Together', '3.2 Case Studies'],
          teaches: ['merged topic'],
          keyTerms: ['term'],
        },
      ],
      totalChars: 20_000,
    };
    const rendered = renderDocumentDigest(twoLevel);
    expect(rendered.text).toContain('3.1 Putting It Together');
    expect(rendered.text).toContain('3.2 Case Studies');
  });
});

describe('lens', () => {
  test('lens prompt requires a full permutation and parse validates it', () => {
    const prompt = buildDigestLensPrompt('learn OS', 'contract', '## Coverage\n### A\n### B\n### C', 'English');
    expect(prompt.system).toContain('permutation');
    expect(parseLensOrder('{"order":[2,0,1]}', 3)).toEqual([2, 0, 1]);
    expect(parseLensOrder('{"order":[2,0]}', 3)).toBeNull();
    expect(parseLensOrder('{"order":[0,0,1]}', 3)).toBeNull();
    expect(parseLensOrder('{"order":[0,1,9]}', 3)).toBeNull();
  });

  test('applyLensOrder reorders sections without dropping any', () => {
    const digest = {
      level: 'single' as const,
      sections: [1, 2, 3].map((i) => ({
        id: `sec_0${i}`,
        heading: `S${i}`,
        chapter: '1',
        headings: [`S${i}`],
        teaches: [`t${i}`],
        keyTerms: [],
        sourceChunkIds: [],
      })),
      totalChars: 100,
    };
    const reordered = applyLensOrder(digest, [2, 0, 1]);
    expect(reordered.sections.map((s) => s.heading)).toEqual(['S3', 'S1', 'S2']);
  });
});

describe('buildDocumentDigest orchestrator', () => {
  test('small documents skip the digest (raw tier) with zero calls', async () => {
    let calls = 0;
    const result = await buildDocumentDigest('short text', {
      aiCall: async () => {
        calls += 1;
        return '{}';
      },
    });
    expect(result.level).toBe('raw');
    expect(calls).toBe(0);
    expect(result.chunks.length).toBeGreaterThanOrEqual(0);
  });

  test('large documents produce enumerative section cards via injected aiCall', async () => {
    const groups = groupChunksByStructure(chapterChunks(SOURCE));
    const result = await buildDocumentDigest(SOURCE, {
      aiCall: async (_system, user) => {
        // The batched prompt lists sections as "### SECTION <id>". Echo each
        // section id into a synthetic card so every section is covered.
        const ids = Array.from(user.matchAll(/### SECTION (sec_\d+)/g), (m) => m[1]);
        const sections = Object.fromEntries(
          ids.map((id) => [id, { teaches: [`${id} topic`], keyTerms: ['term'] }]),
        );
        return JSON.stringify({ sections });
      },
    });
    expect(result.level).toBe('single');
    expect(result.digest.sections.length).toBeGreaterThanOrEqual(groups.length);
    expect(result.batchCalls).toBeGreaterThan(0);
    // Batching collapses several sections into fewer calls than sections.
    expect(result.batchCalls).toBeLessThanOrEqual(groups.length);
  });
});
