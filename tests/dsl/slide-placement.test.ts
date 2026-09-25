import { describe, expect, it } from 'vitest';
import { sanitizeSlidePlacement, validateSlidePlacement, type PPTElement } from '@openmaic/dsl';

function canvas(elements: PPTElement[], viewportSize = 1000, viewportRatio = 0.5625) {
  return { viewportSize, viewportRatio, elements };
}

function textElement(partial: Partial<PPTElement>): PPTElement {
  return {
    id: 'text-1',
    type: 'text',
    left: 40,
    top: 40,
    width: 520,
    height: 120,
    rotate: 0,
    content: '<p>body</p>',
    ...partial,
  } as unknown as PPTElement;
}

function shapeElement(partial: Partial<PPTElement>): PPTElement {
  return {
    id: 'shape-1',
    type: 'shape',
    left: 40,
    top: 40,
    width: 60,
    height: 420,
    rotate: 0,
    viewBox: [200, 200],
    path: 'M0 0 L200 0',
    fill: '#000000',
    ...partial,
  } as unknown as PPTElement;
}

describe('validateSlidePlacement', () => {
  it('flags a solid shape that hangs below the canvas', () => {
    const bar = shapeElement({ top: 642, width: 4, height: 420, fill: '#ff8800' });
    const findings = validateSlidePlacement(canvas([bar, textElement({})]));
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('overflow');
    expect(findings[0].severity).toBe('error');
    expect(findings[0].elementId).toBe('shape-1');
  });

  it('tolerates an element that fits exactly inside the canvas', () => {
    const bar = shapeElement({ top: 140, height: 420, fill: '#ff8800' });
    expect(validateSlidePlacement(canvas([bar]))).toEqual([]);
  });

  it('exempts full-bleed background images from the overflow rule', () => {
    const image = {
      id: 'bg-1',
      type: 'image',
      left: 0,
      top: 0,
      width: 2000,
      height: 1200,
      rotate: 0,
      src: 'asset-1',
      imageType: 'background',
    } as unknown as PPTElement;
    expect(validateSlidePlacement(canvas([image]))).toEqual([]);
  });

  it('exempts low-opacity decorative shapes from the overflow rule', () => {
    const wash = shapeElement({ opacity: 0.1, top: 500, height: 200 });
    const findings = validateSlidePlacement(canvas([wash]));
    expect(findings.every((f) => f.kind !== 'overflow' || f.message !== 'error')).toBe(true);
    expect(findings).toEqual([]);
  });

  it('treats a shape behind text as legal layering', () => {
    const bar = shapeElement({ top: 220, height: 300, fill: '#ff8800' });
    const body = textElement({ left: 100, top: 260, width: 400, height: 200 });
    expect(validateSlidePlacement(canvas([bar, body]))).toEqual([]);
  });

  it('flags text stacked over text as an error', () => {
    const a = textElement({ id: 'text-a', top: 100, height: 200 });
    const b = textElement({ id: 'text-b', left: 60, top: 140, height: 200 });
    const findings = validateSlidePlacement(canvas([a, b]));
    expect(findings.some((f) => f.kind === 'occlusion' && f.severity === 'error')).toBe(true);
  });

  it('downgrades a decorative shape partially covering text to a warn', () => {
    const bar = shapeElement({ top: 300, height: 120, fill: '#ff8800' });
    const body = textElement({ left: 60, top: 140, height: 220 });
    const findings = validateSlidePlacement(canvas([body, bar]));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warn');
    expect(findings[0].kind).toBe('occlusion');
  });

  it('reports nothing for non-intersecting elements', () => {
    const a = textElement({ top: 0, height: 100 });
    const b = textElement({ top: 300, height: 100 });
    expect(validateSlidePlacement(canvas([a, b]))).toEqual([]);
  });
});

describe('sanitizeSlidePlacement', () => {
  it('pulls a hanging shape back inside the canvas', () => {
    const bar = shapeElement({ top: 642, width: 4, height: 420 }) as PPTElement & {
      top: number;
      height: number;
      width: number;
    };
    const slide = canvas([bar]);
    const { changes } = sanitizeSlidePlacement(slide);
    expect(changes).toHaveLength(1);
    expect(bar.top).toBe(142);
    expect(bar.height).toBe(420);
    expect(bar.width).toBe(4);
  });

  it('caps dimensions larger than the canvas', () => {
    const wide = textElement({ width: 2400, height: 1200, left: 10, top: 10 }) as PPTElement & {
      height: number;
    };
    sanitizeSlidePlacement(canvas([wide]));
    expect(wide.width).toBe(1000);
    expect(wide.height).toBe(562);
  });

  it('leaves in-bounds elements untouched', () => {
    const body = textElement({});
    const slide = canvas([body]);
    const { changes } = sanitizeSlidePlacement(slide);
    expect(changes).toEqual([]);
    expect(body.left).toBe(40);
    expect(body.top).toBe(40);
  });

  it('never moves background images', () => {
    const image = {
      id: 'bg-1',
      type: 'image',
      left: -50,
      top: -50,
      width: 1200,
      height: 700,
      rotate: 0,
      src: 'asset-1',
      imageType: 'background',
    } as unknown as PPTElement;
    const { changes } = sanitizeSlidePlacement(canvas([image]));
    expect(changes).toEqual([]);
    expect(image.left).toBe(-50);
  });
});
