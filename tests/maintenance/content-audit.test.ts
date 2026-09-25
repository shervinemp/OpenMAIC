import { describe, expect, it } from 'vitest';
import {
  sceneContentFindings,
  sourceIdsOf,
  splitFamilyDuplicateFindings,
  splitFamilyFindings,
  stripSourceProvenance,
  stripDeadActionAnchors,
  hasSourceProvenance,
  type ContentFinding,
} from '@/lib/maintenance/content-audit';

type AnyScene = Record<string, unknown>;

// The module's scene shape is structural; the tests build plain objects and
// hand them across with the same `as never` cast the repair route already
// uses for AppScene.
const sceneContentFindingsLoose = (scene: unknown, dup?: Set<string>): ContentFinding[] =>
  sceneContentFindings(scene as never, dup);

const slide = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'scene-1',
  type: 'slide',
  order: 226,
  content: {
    canvas: {
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [] as Array<Record<string, unknown>>,
    },
  },
  actions: [] as Array<Record<string, unknown>>,
  ...overrides,
});
const textEl = (id: string, content: string, top = 40, width = 800): Record<string, unknown> => ({
  id,
  type: 'text',
  left: 60,
  top,
  width,
  height: 64,
  content,
});

describe('sceneContentFindings', () => {
  it('returns nothing for a clean slide', () => {
    const scene = slide({ actions: [spot('t1')] });
    setElements(scene, [textEl('t1', '<p>x</p>')]);
    expect(sceneContentFindingsLoose(scene)).toEqual([]);
  });

  it('flags a spotlight referencing a missing element as an error', () => {
    const scene = slide({ actions: [spot('ghost')] });
    setElements(scene, [textEl('t1', '<p>x</p>')]);
    expect(sceneContentFindingsLoose(scene)).toContainEqual(
      expect.objectContaining({ kind: 'action/dead-element-reference', severity: 'error' }),
    );
  });

  it('flags intra-scene duplicate element ids as an error', () => {
    const scene = slide();
    setElements(scene, [textEl('t1', '<p>a</p>'), textEl('t1', '<p>b</p>', 200)]);
    expect(sceneContentFindingsLoose(scene)).toContainEqual(
      expect.objectContaining({ kind: 'identity/duplicate-element-id', severity: 'error' }),
    );
  });

  it('flags unresolved [source N] placeholders as an error and names the element', () => {
    const scene = slide({ actions: [spot('t1')] });
    setElements(scene, [textEl('t1', '<p>shared dims [source 1</p>')]);
    // "[source 1" without the closing bracket is NOT the artifact form.
    expect(sceneContentFindingsLoose(scene)).toEqual([]);
    setElements(scene, [textEl('t1', '<p>shared dims [source 1]</p>')]);
    const findings = sceneContentFindingsLoose(scene);
    expect(findings.filter((f) => f.kind === 'provenance/source-artifact')).toHaveLength(1);
    expect(hasSourceProvenance(scene as never)).toBe(true);
    expect(sourceIdsOf(scene as never).has('t1')).toBe(true);
  });

  it('flags stale order-stamped narration ids as a warning', () => {
    const scene = slide({
      order: 581,
      actions: [{ type: 'speech', audioId: 'tts_s226_action_abc' }, spot('t1')],
    });
    setElements(scene, [textEl('t1', '<p>x</p>')]);
    expect(sceneContentFindingsLoose(scene)).toContainEqual(
      expect.objectContaining({ kind: 'narration/stale-order-audio-id', severity: 'warn' }),
    );
  });

  it('warns when text elements are never spotlighted while siblings are', () => {
    const scene = slide({ actions: [spot('t1')] });
    setElements(scene, [
      textEl('t1', '<p>spotlit</p>'),
      textEl('orphan', '<p>never mentioned</p>', 200),
    ]);
    expect(sceneContentFindingsLoose(scene)).toContainEqual(
      expect.objectContaining({
        kind: 'narration/elements-never-spotlighted',
        severity: 'warn',
      }),
    );
  });

  it('does not warn when every text element is anchored or none are', () => {
    const all = slide({
      actions: [spot('t1'), spot('t2')],
    });
    setElements(all, [textEl('t1', '<p>a</p>'), textEl('t2', '<p>b</p>', 200)]);
    expect(sceneContentFindingsLoose(all).filter((f) => f.kind.startsWith('narration/'))).toEqual(
      [],
    );
    const none = slide({ actions: [{ type: 'speech', text: 'x' }] });
    setElements(none, [textEl('t1', '<p>a</p>'), textEl('t2', '<p>b</p>', 200)]);
    expect(sceneContentFindingsLoose(none).filter((f) => f.kind.startsWith('narration/'))).toEqual(
      [],
    );
  });

  it('ignores non-slide scenes', () => {
    expect(sceneContentFindingsLoose({ id: 'x', type: 'quiz', actions: [] })).toEqual([]);
  });
});

describe('splitFamilyDuplicateFindings', () => {
  it('flags an element id carried onto every part page', () => {
    const base = slide({ id: 's' });
    const p2 = slide({ id: 's__p2' });
    setElements(base, [
      textEl('t1', '<p>a</p>'),
      { id: 'shared-shape', type: 'shape', left: 0, top: 0, width: 10, height: 10 },
      textEl('only-base', '<p>c</p>', 200),
    ]);
    setElements(p2, [
      { id: 'shared-shape', type: 'shape', left: 0, top: 0, width: 10, height: 10 },
      textEl('t2', '<p>d</p>', 200),
    ]);
    const report = splitFamilyDuplicateFindings({ scenes: [base, p2] } as never);
    expect(report).toHaveLength(2); // warned on both carriers
    expect(report[0].sceneId).toBe('s');
    expect(report[0].sharedIds).toEqual(['shared-shape']);
  });

  it('is silent when families have distinct element ids', () => {
    const base = slide({ id: 'a' });
    setElements(base, [textEl('a1', '<p>x</p>')]);
    const other = slide({ id: 'b' });
    setElements(other, [textEl('b1', '<p>y</p>')]);
    expect(splitFamilyDuplicateFindings({ scenes: [base, other] } as never)).toEqual([]);
  });
});

describe('splitFamilyFindings — title-band continuity', () => {
  const heading = (id: string) => textEl(id, '<p style="font-size: 36px;">Title</p>', 40, 880);

  it('warns on the part missing the shared heading', () => {
    const withTitle = slide({ id: 'f' });
    setElements(withTitle, [heading('head')]);
    const without = slide({ id: 'f__p2' });
    setElements(without, [textEl('chip', '<p>chip</p>', 130, 230)]);
    const findings = splitFamilyFindings([withTitle, without] as never);
    expect(findings).toHaveLength(1);
    expect(findings[0].sceneId).toBe('f__p2');
    expect(findings[0].finding.kind).toBe('frame/split-part-missing-title');
  });

  it('is silent when NO page carries a heading (the deck may be untitled)', () => {
    const a = slide({ id: 'g' });
    setElements(a, [textEl('chip', '<p>c</p>', 300, 230)]);
    const b = slide({ id: 'g__p2' });
    setElements(b, [textEl('chip2', '<p>c</p>', 300, 230)]);
    expect(splitFamilyFindings([a, b] as never)).toEqual([]);
  });

  it('does not mistake a narrow chip at the title band for a heading', () => {
    const a = slide({ id: 'h' });
    setElements(a, [heading('head')]);
    const b = slide({ id: 'h__p2' });
    setElements(b, [textEl('narrow', '<p>fact (grain: one row)</p>', 40, 230)]);
    expect(splitFamilyFindings([a, b] as never).map((f) => f.sceneId)).toEqual(['h__p2']);
  });
});

describe('stripSourceProvenance', () => {
  it('strips placeholders and reports exactly the cured elements', () => {
    const scene = slide({ actions: [spot('dirty')] });
    setElements(scene, [
      textEl('dirty', '<p>Conformed dims [source 1] let comparison [source 2].</p>'),
      textEl('clean', '<p>Nothing to strip</p>', 200),
    ]);
    expect([...sourceIdsOf(scene as never)].sort()).toEqual(['dirty']);
    expect(stripSourceProvenance(scene as never)).toBe(1);
    const content = (
      (getElements(scene) as unknown as Array<{ id: string; content?: string }>).find(
        (e) => e.id === 'dirty',
      )?.content ?? ''
    ).replace(/\s+/g, ' ');
    expect(content).toMatch(/Conformed dims let comparison\./);
    expect(content).not.toMatch(/\[source/);
    expect(sourceIdsOf(scene as never).size).toBe(0);
    expect(hasSourceProvenance(scene as never)).toBe(false);
    expect(getElements(scene)).toHaveLength(2);
  });

  it('is idempotent', () => {
    const scene = slide();
    setElements(scene, [textEl('t', '<p>A [source 3] B</p>')]);
    stripSourceProvenance(scene as never);
    expect(stripSourceProvenance(scene as never)).toBe(0);
  });
});

describe('stripDeadActionAnchors (write-time guard)', () => {
  it('drops actions whose elementId is missing from the canvas and keeps the rest', () => {
    const scene = slide();
    setElements(scene, [textEl('t1', '<p>a</p>')]);
    scene.actions = [
      spot('t1'),
      spot('ghost'), // element not on the canvas
      { type: 'speech', text: 'no anchor — untouched' },
      { type: 'speech', audioId: 'tts_s226_x' }, // no elementId — untouched
    ];
    const dropped = stripDeadActionAnchors(scene as never);
    expect(dropped).toBe(1);
    expect((scene.actions as AnyScene[]).map((a) => (a as { type: string }).type)).toEqual([
      'spotlight',
      'speech',
      'speech',
    ]);
  });

  it('is a no-op when every anchor exists and is idempotent', () => {
    const scene = slide({ actions: [spot('t1')] });
    setElements(scene, [textEl('t1', '<p>a</p>')]);
    expect(stripDeadActionAnchors(scene as never)).toBe(0);
    expect(stripDeadActionAnchors(scene as never)).toBe(0);
  });

  it('never strips when the canvas is empty to avoid unjudged wholesale drops', () => {
    const scene = slide({ actions: [spot('t1')] });
    expect(stripDeadActionAnchors(scene as never)).toBe(0);
    expect((scene.actions as AnyScene[]).length).toBe(1);
  });
});

// ---------- helpers ----------

function setElements(scene: AnyScene, elements: AnyScene[]) {
  (scene as { content: { canvas: { elements: AnyScene[] } } }).content.canvas.elements = elements;
}
function getElements(scene: AnyScene): readonly AnyScene[] {
  return (scene as { content: { canvas: { elements: readonly AnyScene[] } } }).content.canvas
    .elements;
}
function spot(elementId: string) {
  return { type: 'spotlight', elementId };
}
