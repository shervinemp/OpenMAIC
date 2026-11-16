import { describe, expect, test } from 'vitest';
import {
  chunkSourceText,
  formatRetrievalContext,
  isSubstantiveText,
  parseRetrievalChunks,
  stripCitationMarkers,
  validateQuizDepth,
  validateSlideDepth,
} from '@openmaic/generation';
import type { PPTElement } from '@openmaic/dsl';
import type { QuizQuestion } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

function textElement(id: string, content: string): PPTElement {
  return {
    id,
    type: 'text',
    left: 0,
    top: 0,
    width: 100,
    height: 40,
    content,
    defaultFontName: '',
    defaultColor: '#000',
    rotate: 0,
  } as PPTElement;
}

function slideOutline(): SceneOutline {
  return {
    id: 's1',
    type: 'slide',
    title: 'The Water Cycle',
    description: 'How water moves through the environment.',
    keyPoints: ['evaporation', 'condensation'],
    order: 1,
  };
}

const RETRIEVAL = [
  'Retrieved from the source material (cite these markers verbatim in your content where the claim comes from, e.g. "[source p.412]"):',
  '',
  '--- [source p.1] (page 1) ---',
  'Evaporation moves water molecules from the liquid phase into vapor when the surface is heated.',
  '',
  '--- [source p.2] (page 2) ---',
  'Condensation returns vapor to liquid water as the air cools.',
].join('\n');

function baseElements(cited: string): PPTElement[] {
  return [
    textElement('t1', '<p>Evaporation moves water molecules from the liquid phase into vapor.</p>'),
    textElement('t2', '<p>Molecules gain energy when the liquid surface is heated by the sun.</p>'),
    textElement(
      't3',
      '<p>For example, a puddle shrinks much faster on a hot day than a cold one.</p>',
    ),
    textElement('t4', `<p>${cited}</p>`),
  ];
}

function citationFindings(findings: string[]): string[] {
  return findings.filter(
    (finding) => finding.includes('shares no key terms') || finding.includes('no key terms'),
  );
}

describe('parseRetrievalChunks', () => {
  test('recovers each rendered chunk with its marker', () => {
    const chunks = parseRetrievalChunks(RETRIEVAL);
    expect(chunks).toEqual([
      {
        citation: 'p.1',
        text: 'Evaporation moves water molecules from the liquid phase into vapor when the surface is heated.',
      },
      {
        citation: 'p.2',
        text: 'Condensation returns vapor to liquid water as the air cools.',
      },
    ]);
  });

  test('handles headers without a page hint and bare web indices', () => {
    const context = [
      '--- [source 1] ---',
      'Paging splits memory into fixed-size frames.',
      '--- [source 2] ---',
      'Scheduling chooses the next runnable task.',
    ].join('\n');
    expect(parseRetrievalChunks(context)).toEqual([
      { citation: '1', text: 'Paging splits memory into fixed-size frames.' },
      { citation: '2', text: 'Scheduling chooses the next runnable task.' },
    ]);
  });

  test('ignores the preamble example marker and empty contexts', () => {
    expect(parseRetrievalChunks('')).toEqual([]);
    expect(parseRetrievalChunks('Cite like "[source p.412]" where relevant.')).toEqual([]);
  });

  test('round-trips chunked source text through formatRetrievalContext', () => {
    const source = [
      'Page 1',
      'Evaporation moves water molecules from the liquid phase into vapor.',
      '',
      'Page 2',
      'Condensation returns vapor to liquid water as the air cools.',
    ].join('\n');
    const chunks = chunkSourceText(source).filter((chunk) => chunk.pageHint);
    const parsed = parseRetrievalChunks(formatRetrievalContext(chunks));
    expect(parsed.map((chunk) => chunk.citation)).toEqual(chunks.map((chunk) => chunk.citation));
    expect(parsed[0].text).toBe(chunks[0].text);
  });
});

describe('stripCitationMarkers', () => {
  test('removes only citation markers', () => {
    const stripped = (text: string) => stripCitationMarkers(text).replace(/\s+/g, ' ').trim();
    expect(stripped('Vapor rises. [source p.1] [source ch.3]')).toBe('Vapor rises.');
    expect(stripped('[source 2] explains frames')).toBe('explains frames');
    expect(stripped('No citations here.')).toBe('No citations here.');
  });
});

describe('deterministic citation support', () => {
  test('flags a long claim with no lexical link to the retrieved material', () => {
    const report = validateSlideDepth(
      slideOutline(),
      baseElements(
        'The Roman Senate appointed consuls annually to command the legions and manage the treasury. [source p.1]',
      ),
      { retrievalContext: RETRIEVAL },
    );
    const support = citationFindings(report.findings);
    expect(support).toHaveLength(1);
    expect(support[0]).toContain('Roman Senate');
    expect(support[0]).toContain('[source p.1]');
    expect(support[0]).toContain('no key terms with the retrieved material');
  });

  test('flags a claim whose wording belongs to a different retrieved chunk', () => {
    const report = validateSlideDepth(
      slideOutline(),
      baseElements('Condensation happens when humid air cools below its dew point. [source p.1]'),
      { retrievalContext: RETRIEVAL },
    );
    const support = citationFindings(report.findings);
    expect(support).toHaveLength(1);
    expect(support[0]).toContain('shares no key terms with [source p.1]');
    expect(support[0]).toContain('[source p.2]');
  });

  test('leaves a short paraphrase alone even when it overlaps nothing', () => {
    const report = validateSlideDepth(
      slideOutline(),
      baseElements('Institutions shape long-run economic outcomes. [source p.1]'),
      { retrievalContext: RETRIEVAL },
    );
    expect(citationFindings(report.findings)).toEqual([]);
  });

  test('accepts a claim that shares a term with its cited chunk', () => {
    const report = validateSlideDepth(
      slideOutline(),
      baseElements('Water molecules evaporate from the liquid surface when heated. [source p.1]'),
      { retrievalContext: RETRIEVAL },
    );
    expect(citationFindings(report.findings)).toEqual([]);
  });

  test('attaches a trailing marker to the sentence it follows', () => {
    const report = validateSlideDepth(
      slideOutline(),
      baseElements(
        'The Roman Senate appointed consuls annually to command the legions and manage the treasury. [source p.1]',
      ),
      { retrievalContext: RETRIEVAL },
    );
    expect(citationFindings(report.findings)).toHaveLength(1);
  });

  test('union of cited chunks supports a multi-source claim', () => {
    const report = validateSlideDepth(
      slideOutline(),
      baseElements(
        'Evaporation feeds condensation as heated vapor cools. [source p.1] [source p.2]',
      ),
      { retrievalContext: RETRIEVAL },
    );
    expect(citationFindings(report.findings)).toEqual([]);
  });

  test('skips summary framing, short claims and unknown markers', () => {
    const meta = validateSlideDepth(
      slideOutline(),
      baseElements('In summary, these three stages form a loop. [source p.1]'),
      { retrievalContext: RETRIEVAL },
    );
    expect(citationFindings(meta.findings)).toEqual([]);

    const short = validateSlideDepth(slideOutline(), baseElements('See also. [source p.1]'), {
      retrievalContext: RETRIEVAL,
    });
    expect(citationFindings(short.findings)).toEqual([]);

    // An unknown marker is the existing hallucinated-citation finding, not a
    // support finding (there is no chunk to compare against).
    const unknown = validateSlideDepth(
      slideOutline(),
      baseElements('The Roman Senate appointed consuls annually. [source p.99]'),
      { retrievalContext: RETRIEVAL },
    );
    expect(citationFindings(unknown.findings)).toEqual([]);
    expect(unknown.findings.some((finding) => finding.includes('not present'))).toBe(true);
  });

  test('keeps a mid-sentence marker with the whole claim', () => {
    const report = validateSlideDepth(
      slideOutline(),
      baseElements(
        'Photosynthesis inside chloroplasts [source p.1] converts light energy into glucose and releases oxygen.',
      ),
      { retrievalContext: RETRIEVAL },
    );
    const support = citationFindings(report.findings);
    expect(support).toHaveLength(1);
    expect(support[0]).toContain('Photosynthesis inside chloroplasts');
    expect(support[0]).toContain('converts light energy');
  });

  test('attaches a marker-only element to the preceding claim', () => {
    const elements = [
      textElement('t1', '<p>Evaporation moves water molecules into vapor.</p>'),
      textElement('t2', '<p>Molecules gain energy when the liquid surface is heated.</p>'),
      textElement(
        't3',
        '<p>The Roman Senate appointed consuls annually to command the legions and manage the treasury.</p>',
      ),
      textElement('t4', '<p>[source p.1]</p>'),
    ];
    const report = validateSlideDepth(slideOutline(), elements, { retrievalContext: RETRIEVAL });
    const support = citationFindings(report.findings);
    expect(support).toHaveLength(1);
    expect(support[0]).toContain('Roman Senate');
  });

  test('unions multiple chunks that share one web citation index', () => {
    const retrieval = [
      '--- [source 1] ---',
      'Paging splits memory into fixed-size frames.',
      '--- [source 1] ---',
      'A page table maps virtual addresses to frames.',
    ].join('\n');
    const report = validateSlideDepth(
      slideOutline(),
      baseElements('The page table maps virtual addresses to memory frames. [source 1]'),
      { retrievalContext: retrieval },
    );
    expect(citationFindings(report.findings)).toEqual([]);
  });

  test('caps reported claims and summarizes the remainder', () => {
    const elements = baseElements(
      [
        'The Roman Senate appointed consuls annually to command the legions and manage the treasury. [source p.1]',
        'Medieval guilds regulated craft quality, set prices, and trained apprentices in walled cities. [source p.1]',
        'Photosynthesis converts light energy into chemical bonds inside the chloroplasts of plant cells. [source p.1]',
      ].join(' '),
    );
    const report = validateSlideDepth(slideOutline(), elements, { retrievalContext: RETRIEVAL });
    const support = citationFindings(report.findings);
    expect(support).toHaveLength(3); // two detailed claims + one summary
    expect(support[2]).toContain('1 more cited claim');
  });

  test('checks quiz explanations against the cited chunk', () => {
    const questions: QuizQuestion[] = [
      {
        id: 'q1',
        type: 'single',
        question: 'What happens to water molecules during evaporation?',
        options: [
          { value: 'A', label: 'They leave the liquid as vapor' },
          { value: 'B', label: 'They freeze into ice' },
        ],
        answer: ['A'],
        analysis:
          'The Roman Senate appointed consuls annually to command the legions and manage the treasury. [source p.1]',
        hasAnswer: true,
      },
    ];
    const outline: SceneOutline = {
      id: 'q',
      type: 'quiz',
      title: 'Water Cycle Check',
      description: 'Check understanding.',
      keyPoints: ['evaporation'],
      order: 1,
      quizConfig: { questionCount: 1, difficulty: 'medium', questionTypes: ['single'] },
    };
    const report = validateQuizDepth(outline, questions, RETRIEVAL);
    expect(citationFindings(report.findings)).toHaveLength(1);
  });

  test('matches Chinese claims by character bigram', () => {
    const retrieval = ['--- [source p.1] ---', '水循环包括蒸发、凝结和降水三个主要环节。'].join(
      '\n',
    );
    const supported = validateSlideDepth(
      slideOutline(),
      baseElements('蒸发使液态水变成水蒸气进入大气。 [source p.1]'),
      { retrievalContext: retrieval },
    );
    expect(citationFindings(supported.findings)).toEqual([]);

    const unsupported = validateSlideDepth(
      slideOutline(),
      baseElements('光合作用将光能转化为化学能储存在糖中。 [source p.1]'),
      { retrievalContext: retrieval },
    );
    expect(citationFindings(unsupported.findings)).toHaveLength(1);
  });

  test('leaves content without a retrieval context untouched', () => {
    const cited = baseElements('The Roman Senate appointed consuls annually.');
    expect(
      isSubstantiveText('The Roman Senate appointed consuls annually to command the legions.'),
    ).toBe(true);
    const report = validateSlideDepth(slideOutline(), cited);
    expect(citationFindings(report.findings)).toEqual([]);
  });
});
