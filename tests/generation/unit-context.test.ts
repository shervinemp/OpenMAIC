import { describe, expect, test } from 'vitest';
import { buildUnitContext, MAX_UNIT_CONTEXT_CHARS } from '@/lib/generation/unit-context';
import type { SceneOutline } from '@/lib/types/generation';

function outline(id: string, order: number, lessonId: string, title: string): SceneOutline {
  return {
    id,
    type: 'slide',
    title,
    description: `Describe ${title}`,
    keyPoints: [`Point A of ${title}`, `Point B of ${title}`],
    order,
    lessonId,
  };
}

const DECK: SceneOutline[] = [
  outline('s1', 1, 'lesson_1', 'Process abstraction'),
  outline('s2', 2, 'lesson_1', 'Process states'),
  outline('s3', 3, 'lesson_2', 'Context switching'),
  outline('s4', 4, 'lesson_2', 'PCB structure'),
  outline('s5', 5, 'lesson_3', 'FCFS scheduling'),
  outline('s6', 6, 'lesson_3', 'Round robin'),
  outline('s7', 7, 'lesson_4', 'Address spaces'),
  outline('s8', 8, 'lesson_4', 'Page tables'),
  outline('s9', 9, 'lesson_5', 'Virtual memory'),
  outline('s10', 10, 'lesson_5', 'TLB and caches'),
];

describe('buildUnitContext (Phase 2 §15.5)', () => {
  test('threads earlier scenes from the same unit (LESSONS_PER_UNIT window)', () => {
    // Unit 1 = lessons 1-4 (LESSONS_PER_UNIT = 4). Scene 6 (lesson 3) is in
    // unit 1: everything before it in lessons 1-4 is threaded.
    const context = buildUnitContext(DECK[5], DECK);
    expect(context).toContain('What Was Taught So Far');
    expect(context).toContain('Process abstraction');
    expect(context).toContain('FCFS scheduling');
    expect(context).toContain('do not re-teach it');
    // Scene 6 itself is never included.
    expect(context).not.toContain('Round robin');
  });

  test('unit boundaries stop cross-unit leakage', () => {
    // Scene 9 (lesson 5) opens unit 2: unit 1 material must not leak in.
    const context = buildUnitContext(DECK[8], DECK);
    expect(context).toBe('');

    // Scene 10 (lesson 5) sees only earlier unit-2 material.
    const context10 = buildUnitContext(DECK[9], DECK);
    expect(context10).toContain('Virtual memory');
    expect(context10).not.toContain('FCFS scheduling');
    expect(context10).not.toContain('Page tables');
  });

  test('first scene of a unit has nothing to thread', () => {
    expect(buildUnitContext(DECK[0], DECK)).toBe('');
  });

  test('legacy decks without lesson ids return empty', () => {
    const legacy = DECK.map((o) => ({ ...o, lessonId: undefined }));
    expect(buildUnitContext(legacy[3], legacy)).toBe('');
  });

  test('caps the block defensively', () => {
    const bigDeck: SceneOutline[] = Array.from({ length: 40 }, (_, i) =>
      outline(`s${i}`, i + 1, 'lesson_1', `Scene ${i} — ${'x'.repeat(300)}`),
    );
    const context = buildUnitContext(bigDeck[39], bigDeck);
    expect(context.length).toBeLessThanOrEqual(MAX_UNIT_CONTEXT_CHARS + 20);
    expect(context).toContain('(truncated)');
  });
});
