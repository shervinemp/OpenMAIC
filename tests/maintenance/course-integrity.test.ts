// @vitest-environment jsdom
// Keep the .test.ts suffix: the repository's Vitest include intentionally
// discovers TypeScript tests with this extension.

import { describe, expect, it } from 'vitest';

import { speakableText } from '@/lib/audio/tts-utils';
import { findWidgetScriptFailure } from '@/lib/interactive/widget-script-check';
import { dedupeElementIds, sceneContentFindings } from '@/lib/maintenance/content-audit';
import { healCourseIntegrity } from '@/lib/maintenance/course-integrity';
import type { Scene } from '@/lib/types/stage';

const text = (id: string, content: string) => ({
  id,
  type: 'text',
  left: 40,
  top: 40,
  width: 800,
  height: 60,
  content: `<p>${content}</p>`,
});
const slide = (id: string, order: number, elements: unknown[], actions: unknown[] = []) =>
  ({
    id,
    stageId: 'stage-1',
    outlineId: id,
    type: 'slide',
    title: id,
    order,
    content: { type: 'slide', canvas: { id: `canvas-${id}`, elements } },
    actions,
  }) as unknown as Scene;
const speech = (id: string, words: string) => ({ id, type: 'speech', text: words });

describe('healCourseIntegrity', () => {
  it('spreads a silent split family’s narration across its parts', () => {
    const scenes = [
      slide(
        'deck',
        1,
        [text('t1', 'Storage formats and open Parquet files')],
        [
          speech('s1', 'Storage formats first: open Parquet files.'),
          speech('s2', 'Transactions come from the transaction log.'),
          speech('s3', 'Cost: compute scales apart from object storage.'),
        ],
      ),
      slide('deck__p2', 2, [text('t2', 'Transactions and the transaction log')]),
      slide('deck__p3', 3, [text('t3', 'Cost of compute and object storage')]),
    ];

    const heal = healCourseIntegrity(scenes);

    const actionsOf = (id: string) =>
      (heal.updates.find((u) => u.sceneId === id)?.patch.actions ?? []).map(
        (a) => (a as { id: string }).id,
      );
    expect(actionsOf('deck')).toEqual(['s1']);
    expect(actionsOf('deck__p2')).toEqual(['s2']);
    expect(actionsOf('deck__p3')).toEqual(['s3']);
    expect(heal.report.narrationFamilies).toBe(1);
    // Pure: the stored scenes are untouched.
    expect(scenes[0]!.actions).toHaveLength(3);
    expect(scenes[1]!.actions).toHaveLength(0);
  });

  it('leaves a family alone when its parts already speak or it is anchored', () => {
    const anchored = [
      slide('a', 1, [text('t1', 'x')], [{ id: 'sp', type: 'spotlight', elementId: 't1' }]),
      slide('a__p2', 2, [text('t2', 'y')]),
    ];
    const spoken = [
      slide('b', 1, [text('t1', 'x')], [speech('s1', 'x')]),
      slide('b__p2', 2, [text('t2', 'y')], [speech('s2', 'y')]),
    ];

    expect(healCourseIntegrity([...anchored, ...spoken]).report.narrationFamilies).toBe(0);
  });

  it('strips dead spotlights and renames duplicate element ids', () => {
    const scene = slide(
      'solo',
      1,
      [text('dup', 'first'), text('dup', 'second')],
      [
        { id: 'dead', type: 'spotlight', elementId: 'gone' },
        { id: 'live', type: 'spotlight', elementId: 'dup' },
      ],
    );

    const heal = healCourseIntegrity([scene]);

    const patch = heal.updates[0]!.patch;
    expect((patch.actions ?? []).map((a) => (a as { id: string }).id)).toEqual(['live']);
    const ids = (
      patch.content as { canvas: { elements: Array<{ id: string }> } }
    ).canvas.elements.map((element) => element.id);
    expect(ids).toEqual(['dup', 'dup-dup2']);
    expect(heal.report).toMatchObject({ anchorsStripped: 1, idsRenamed: 1 });
  });

  it('rewrites a quiz key that grades a correct choice as wrong', () => {
    const quiz = {
      id: 'quiz',
      stageId: 'stage-1',
      type: 'quiz',
      title: 'quiz',
      order: 1,
      content: {
        type: 'quiz',
        questions: [
          {
            id: 'q1',
            type: 'single',
            question: 'Which dimension?',
            options: [
              { value: 'A', label: 'Completeness, because values are absent' },
              { value: 'B', label: 'Accuracy, because values are wrong' },
            ],
            answer: ['Completeness'],
          },
        ],
      },
      actions: [],
    } as unknown as Scene;

    const heal = healCourseIntegrity([quiz]);

    expect(heal.updates[0]?.patch.content).toMatchObject({
      questions: [{ id: 'q1', answer: ['A'] }],
    });
    expect(heal.updates[0]?.patch).not.toHaveProperty('actions');
    expect(heal.report.quizKeysHealed).toBe(1);
  });

  it('reports a widget whose script cannot run, without changing it', () => {
    const widget = {
      id: 'widget',
      stageId: 'stage-1',
      type: 'interactive',
      title: 'widget',
      order: 1,
      content: { type: 'interactive', html: '<script>let x = ;</script>' },
      actions: [],
    } as unknown as Scene;

    const heal = healCourseIntegrity([widget]);

    expect(heal.brokenWidgets).toEqual([
      { sceneId: 'widget', message: expect.stringContaining('widget script 1 cannot run') },
    ]);
    expect(heal.updates).toEqual([]);
  });

  it('changes nothing on a healthy course', () => {
    const heal = healCourseIntegrity([
      slide('ok', 1, [text('t1', 'fine')], [speech('s1', 'fine')]),
    ]);

    expect(heal.updates).toEqual([]);
    expect(heal.brokenWidgets).toEqual([]);
  });
});

describe('findWidgetScriptFailure', () => {
  it('reports the first classic inline script that cannot parse', () => {
    expect(
      findWidgetScriptFailure('<script>const ok = 1;</script><script>state counts = [];</script>'),
    ).toMatchObject({ scriptIndex: 2 });
  });

  it('skips data, module and external scripts, and templates', () => {
    expect(
      findWidgetScriptFailure(
        [
          '<script type="application/json">{ not: js }</script>',
          '<script type="module">import x from "./x.js"; x(</script>',
          '<script src="lib.js"></script>',
          '<template><script>broken(</script></template>',
          '<script>const fine = true;</script>',
        ].join(''),
      ),
    ).toBeNull();
  });
});

describe('dedupeElementIds', () => {
  it('lets the semantics gate pass once repeats are renamed', () => {
    const scene = slide('s', 1, [text('a', 'one'), text('a', 'two'), text('a-dup2', 'three')]);
    expect(sceneContentFindings(scene as never).some((f) => f.severity === 'error')).toBe(true);

    expect(dedupeElementIds(scene as never)).toBe(1);

    const ids = (scene.content as { canvas: { elements: Array<{ id: string }> } }).canvas.elements;
    expect(ids.map((element) => element.id)).toEqual(['a', 'a-dup3', 'a-dup2']);
    expect(sceneContentFindings(scene as never).some((f) => f.severity === 'error')).toBe(false);
  });
});

describe('speakableText', () => {
  it('drops markup a TTS provider would read aloud, and keeps the words', () => {
    expect(speakableText('Call `mask_email` on **every** row.')).toBe(
      'Call mask_email on every row.',
    );
    expect(speakableText('# Heading\n- first point\n* second point')).toBe(
      'Heading\nfirst point\nsecond point',
    );
    expect(speakableText('See [the docs](https://example.com) for *details*.')).toBe(
      'See the docs for details.',
    );
  });

  it('leaves identifiers and arithmetic alone', () => {
    expect(speakableText('Read _last_checkpoint first.')).toBe('Read _last_checkpoint first.');
    expect(speakableText('500M rows * 2 KB = 1 TB')).toBe('500M rows * 2 KB = 1 TB');
  });
});
