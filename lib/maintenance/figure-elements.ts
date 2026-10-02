/**
 * Canvas elements for an adopted figure proposal.
 *
 * A proposal describes a connector only by the box it occupies (left, top,
 * width, height). A line element is drawn between two points relative to its
 * own origin (`start` / `end`), plus a stroke width, and the renderer reads
 * `start[0]`: a line saved without them throws inside the renderer and takes the
 * whole slide down. So the box becomes a segment here: along its one long side
 * when it is a horizontal or vertical rule, and from its top-left to its
 * bottom-right corner when it is a diagonal.
 */

const RULE_THICKNESS = 4;
const STROKE_WIDTH = 2;

export interface FigureShape {
  id: string;
  kind: 'box' | 'line';
  left: number;
  top: number;
  width: number;
  height: number;
  label?: string;
}

export function figureShapeToElement(shape: FigureShape): Record<string, unknown> {
  const width = Number(shape.width);
  const height = Number(shape.height);
  if (shape.kind === 'line') {
    const horizontal = height <= RULE_THICKNESS && width > height;
    const vertical = width <= RULE_THICKNESS && height > width;
    return {
      id: shape.id,
      type: 'line',
      left: shape.left,
      top: shape.top,
      width: STROKE_WIDTH,
      start: [0, 0],
      end: horizontal ? [width, 0] : vertical ? [0, height] : [width, height],
      style: 'solid',
      color: '#1f3864',
      points: ['', ''],
    };
  }
  const element: Record<string, unknown> = {
    id: shape.id,
    type: 'shape',
    left: shape.left,
    top: shape.top,
    width,
    height: Math.max(2, height),
    path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
    viewBox: [1, 1],
    fixedRatio: false,
    fill: '#e8edf4',
    strokeWidth: 1,
    strokeColor: '#1f3864',
  };
  if (typeof shape.label === 'string' && shape.label) {
    element.text = shape.label;
    element.textType = 'text';
  }
  return element;
}
