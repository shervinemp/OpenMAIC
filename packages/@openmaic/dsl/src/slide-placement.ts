import type { PPTElement, PPTImageElement, PPTShapeElement } from './slides.js';

export type PlacementFindingKind = 'overflow' | 'occlusion';

export interface PlacementFinding {
  kind: PlacementFindingKind;
  severity: 'error' | 'warn';
  message: string;
  elementId: string;
  elementIndex: number;
  otherElementId?: string;
  otherElementIndex?: number;
  coveredFraction?: number;
}

export interface PlacementSanitizeChange {
  elementId: string;
  elementIndex: number;
  from: { left: number; top: number; width: number; height: number };
  to: { left: number; top: number; width: number; height: number };
}

interface CanvasLike {
  viewportSize: number;
  viewportRatio: number;
  elements: PPTElement[];
}

const EDGE_TOLERANCE = 1;
const ROTATE_SKIP_DEGREES = 3;
const OVERLAP_REPORT_FRACTION = 0.08;
const OVERLAP_ERROR_FRACTION = 0.4;
const DECORATIVE_OPACITY = 0.25;
const FULL_BLEED_FRACTION = 0.9;

type Rect = { left: number; top: number; width: number; height: number };

function rectArea(rect: Rect): number {
  return rect.width * rect.height;
}

function elementRect(element: PPTElement): Rect {
  const height = element.type === 'line' ? 0 : element.height;
  return { left: element.left, top: element.top, width: element.width, height };
}

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

function isRotated(element: PPTElement): boolean {
  const rotate = 'rotate' in element ? (element.rotate as number | undefined) : undefined;
  return Math.abs(typeof rotate === 'number' ? rotate : 0) >= ROTATE_SKIP_DEGREES;
}

function isDecorativeShape(element: PPTElement): element is PPTShapeElement {
  return element.type === 'shape' && (element as PPTShapeElement).text === undefined;
}

function isTransparent(element: PPTElement): boolean {
  const opacity = (element as PPTShapeElement).opacity;
  return typeof opacity === 'number' && opacity < DECORATIVE_OPACITY;
}

function isBackgroundImage(element: PPTElement): element is PPTImageElement {
  return element.type === 'image' && (element as PPTImageElement).imageType === 'background';
}

function isOpaqueOverlay(element: PPTElement): boolean {
  return element.type !== 'line' && !isTransparent(element);
}

function fullBleed(element: PPTElement, canvasArea: number): boolean {
  return rectArea(elementRect(element)) >= FULL_BLEED_FRACTION * canvasArea;
}

export function validateSlidePlacement(canvas: CanvasLike): PlacementFinding[] {
  const findings: PlacementFinding[] = [];
  const canvasWidth = canvas.viewportSize;
  const canvasHeight = canvas.viewportSize * canvas.viewportRatio;
  const canvasArea = canvasWidth * canvasHeight;

  canvas.elements.forEach((element, index) => {
    if (element.type === 'line') return;
    const rect = elementRect(element);
    const canvasRect = { left: 0, top: 0, width: canvasWidth, height: canvasHeight };
    const onCanvas = intersects(rect, canvasRect);
    const crossingEdge =
      rect.left < -EDGE_TOLERANCE ||
      rect.top < -EDGE_TOLERANCE ||
      rect.left + rect.width > canvasWidth + EDGE_TOLERANCE ||
      rect.top + rect.height > canvasHeight + EDGE_TOLERANCE;
    if (!crossingEdge) return;
    if (
      onCanvas &&
      (isBackgroundImage(element) ||
        fullBleed(element, canvasArea) ||
        (isDecorativeShape(element) && isTransparent(element)))
    ) {
      return;
    }
    const overflowingEdge = !onCanvas
      ? 'off-canvas entirely'
      : rect.left < -EDGE_TOLERANCE
        ? 'left'
        : rect.top < -EDGE_TOLERANCE
          ? 'top'
          : rect.left + rect.width > canvasWidth + EDGE_TOLERANCE
            ? 'right'
            : 'bottom';
    findings.push({
      kind: 'overflow',
      severity: 'error',
      message: `element bleeds off-canvas on the ${overflowingEdge} edge`,
      elementId: element.id,
      elementIndex: index,
    });
  });

  for (let behindIndex = 0; behindIndex < canvas.elements.length; behindIndex += 1) {
    const behind = canvas.elements[behindIndex];
    if (behind.type === 'line' || isRotated(behind)) continue;
    const behindRect = elementRect(behind);
    for (let frontIndex = behindIndex + 1; frontIndex < canvas.elements.length; frontIndex += 1) {
      const front = canvas.elements[frontIndex];
      if (front.type === 'line' || isRotated(front)) continue;
      const frontRect = elementRect(front);
      if (!intersects(behindRect, frontRect)) continue;
      if (!isOpaqueOverlay(front)) continue;
      if (isBackgroundImage(behind) || fullBleed(behind, canvasArea)) continue;
      if (isDecorativeShape(behind) || isTransparent(behind)) continue;
      const overlap = intersectionArea(behindRect, frontRect);
      const smaller = Math.min(rectArea(behindRect), rectArea(frontRect));
      const fraction = smaller > 0 ? overlap / smaller : 0;
      if (fraction < OVERLAP_REPORT_FRACTION) continue;
      const severity =
        isDecorativeShape(front) || fraction < OVERLAP_ERROR_FRACTION ? 'warn' : 'error';
      findings.push({
        kind: 'occlusion',
        severity,
        message:
          severity === 'warn' && isDecorativeShape(front)
            ? `decorative shape covers ${Math.round(fraction * 100)}% of a lower element`
            : `element covers ${Math.round(fraction * 100)}% of a lower element`,
        elementId: front.id,
        elementIndex: frontIndex,
        otherElementId: behind.id,
        otherElementIndex: behindIndex,
        coveredFraction: Number(fraction.toFixed(3)),
      });
    }
  }

  return findings;
}

export interface PlacementSanitizeResult {
  changes: PlacementSanitizeChange[];
}

export function sanitizeSlidePlacement(canvas: CanvasLike): PlacementSanitizeResult {
  const changes: PlacementSanitizeChange[] = [];
  const canvasWidth = canvas.viewportSize;
  const canvasHeight = canvas.viewportSize * canvas.viewportRatio;

  canvas.elements.forEach((element, index) => {
    if (element.type === 'line' || isBackgroundImage(element)) return;
    const original = {
      left: element.left,
      top: element.top,
      width: element.width,
      height: element.height,
    };
    const width = Math.min(original.width, Math.floor(canvasWidth));
    const height = Math.min(original.height, Math.floor(canvasHeight));
    const left = Math.max(0, Math.floor(Math.min(original.left, canvasWidth - width)));
    const top = Math.max(0, Math.floor(Math.min(original.top, canvasHeight - height)));
    if (
      left === original.left &&
      top === original.top &&
      width === original.width &&
      height === original.height
    ) {
      return;
    }
    element.left = Math.round(left);
    element.top = Math.round(top);
    element.width = Math.round(width);
    element.height = Math.round(height);
    changes.push({
      elementId: element.id,
      elementIndex: index,
      from: original,
      to: { left: element.left, top: element.top, width: element.width, height: element.height },
    });
  });

  return { changes };
}
