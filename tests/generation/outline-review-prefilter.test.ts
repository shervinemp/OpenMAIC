import { describe, expect, it } from 'vitest';

import { prefilterOutlineReview } from '@/lib/generation/outline-review-prefilter';
import type { SceneOutline } from '@/lib/types/generation';

/**
 * The prefilter can only ACCEPT. Every test that expects escalation is
 * asserting the judge still gets a chance to look; none of them asserts a
 * rejection, because the prefilter has no reject verdict.
 */

function outline(overrides: Partial<SceneOutline> & Pick<SceneOutline, 'order'>): SceneOutline {
  return {
    id: `s${overrides.order}`,
    type: 'slide',
    title: `Scene ${overrides.order}`,
    description: 'A concrete explanation with worked details.',
    keyPoints: ['first point', 'second point'],
    ...overrides,
  };
}

const PROCESS_DECK: SceneOutline[] = [
  outline({
    order: 1,
    title: 'Process lifecycle states',
    description: 'A process moves through ready, running and blocked states.',
    keyPoints: ['ready', 'running', 'blocked'],
  }),
  outline({
    order: 2,
    title: 'Threads vs processes',
    description: 'Threads share an address space while processes do not.',
    keyPoints: ['shared memory', 'context switch cost'],
  }),
];

describe('prefilterOutlineReview', () => {
  it('accepts a concrete deck whose objectives are carried in order', () => {
    const result = prefilterOutlineReview(
      {
        title: 'Process abstraction',
        objectives: ['Define a process', 'Compare threads and processes'],
      },
      PROCESS_DECK,
    );

    expect(result.reasons).toEqual([]);
    expect(result.accept).toBe(true);
  });

  it('escalates when an on-topic scene is surrounded by filler', () => {
    const result = prefilterOutlineReview(
      { title: 'Process abstraction', objectives: ['Define a process'] },
      [
        PROCESS_DECK[0]!,
        outline({
          order: 2,
          title: 'Office ergonomics',
          description: 'Desk height and chair adjustment for comfortable typing.',
          keyPoints: ['desk height', 'chair angle'],
        }),
      ],
    );

    expect(result.accept).toBe(false);
    expect(result.reasons).toContain('scene 2 is off-topic for the lesson');
  });

  it('accepts a scene carrying all but one term of a longer objective', () => {
    const result = prefilterOutlineReview(
      { title: 'Virtual memory', objectives: ['Explain how virtual memory works'] },
      [
        outline({
          order: 1,
          title: 'Virtual memory layout',
          description: 'Virtual memory maps pages to frames through a page table.',
          keyPoints: ['page table', 'frame allocation'],
        }),
      ],
    );

    expect(result.reasons).toEqual([]);
    expect(result.accept).toBe(true);
  });

  it('escalates when an objective has no single scene carrying it', () => {
    const result = prefilterOutlineReview(
      {
        title: 'Process abstraction',
        objectives: ['Define a process', 'Analyze virtual memory'],
      },
      PROCESS_DECK,
    );

    expect(result.accept).toBe(false);
    expect(result.reasons).toContain('objective 2 is not carried by any single scene');
  });

  it('escalates on a placeholder description', () => {
    const result = prefilterOutlineReview(
      { title: 'Process abstraction', objectives: ['Define a process'] },
      [
        outline({
          order: 1,
          title: 'Process lifecycle states',
          description: 'Introduce the topic.',
          keyPoints: ['ready', 'running'],
        }),
      ],
    );

    expect(result.accept).toBe(false);
    expect(result.reasons).toContain('scene 1 has a placeholder description');
  });

  it('escalates when a scene has fewer than two key points', () => {
    const result = prefilterOutlineReview(
      { title: 'Process abstraction', objectives: ['Define a process'] },
      [
        outline({
          order: 1,
          title: 'Process lifecycle states',
          description: 'A process moves through ready, running and blocked states.',
          keyPoints: ['ready'],
        }),
      ],
    );

    expect(result.accept).toBe(false);
    expect(result.reasons).toContain('scene 1 has fewer than 2 key points');
  });

  it('escalates on repeated scene titles and repeated key-point sets', () => {
    const result = prefilterOutlineReview({ title: 'Process abstraction', objectives: [] }, [
      outline({
        order: 1,
        title: 'Process lifecycle states',
        description: 'A process moves through ready, running and blocked states.',
        keyPoints: ['ready', 'running'],
      }),
      outline({
        order: 2,
        title: 'Process lifecycle states',
        description: 'The same states explained a second time.',
        keyPoints: ['ready', 'running'],
      }),
    ]);

    expect(result.accept).toBe(false);
    expect(result.reasons).toContain('scene 2 repeats an earlier scene title');
    expect(result.reasons).toContain("scene 2 repeats an earlier scene's key points");
  });

  it('escalates when a later objective is carried by an earlier scene', () => {
    const result = prefilterOutlineReview(
      {
        title: 'Process abstraction',
        objectives: ['Compare threads and processes', 'Define a process'],
      },
      PROCESS_DECK,
    );

    expect(result.accept).toBe(false);
    expect(result.reasons).toContain(
      'objective 2 is carried before the objective that precedes it',
    );
  });

  it('accepts a lesson with no objectives once the scenes themselves are concrete', () => {
    const result = prefilterOutlineReview(
      { title: 'Process abstraction', objectives: [] },
      PROCESS_DECK,
    );

    expect(result.reasons).toEqual([]);
    expect(result.accept).toBe(true);
  });

  it('escalates when the deck never mentions the lesson title', () => {
    const result = prefilterOutlineReview(
      { title: 'Kernel scheduling', objectives: ['Define a process'] },
      PROCESS_DECK,
    );

    expect(result.accept).toBe(false);
    expect(result.reasons).toContain('deck does not mention the lesson title');
  });

  it('escalates an empty deck instead of accepting it', () => {
    const result = prefilterOutlineReview(
      { title: 'Process abstraction', objectives: ['Define a process'] },
      [],
    );

    expect(result.accept).toBe(false);
    expect(result.reasons).toEqual(['deck has no scenes']);
  });

  it('matches CJK objectives against CJK scenes', () => {
    const result = prefilterOutlineReview(
      { title: '进程管理', objectives: ['理解进程的生命周期'] },
      [
        outline({
          order: 1,
          title: '进程生命周期',
          description: '进程在就绪、运行和阻塞状态之间转换。',
          keyPoints: ['就绪', '运行', '阻塞'],
        }),
      ],
    );

    expect(result.reasons).toEqual([]);
    expect(result.accept).toBe(true);
  });
});
