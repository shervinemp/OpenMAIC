import { nanoid } from 'nanoid';

/**
 * Split a slide whose text rows cannot fit one canvas into two slides.
 *
 * This is the structural fix for the occlusion debt the relayout cannot heal:
 * moving or shrinking rows only helps while the content actually fits. A
 * continuation scene carries the second half of the rows, a fresh outline so
 * the document stays one-scene-per-outline, and a fractional order that sorts
 * it immediately after the original.
 */
export interface SceneSplit {
  scene: Record<string, unknown>;
  continuation: Record<string, unknown>;
  continuationOutline: Record<string, unknown>;
}

type Canvas = {
  viewportSize?: number;
  viewportRatio?: number;
  theme?: unknown;
  elements: Array<Record<string, unknown>>;
};

const HEADING_MARGIN = 40;
const BOTTOM_MARGIN = 16;

function rowHeight(element: Record<string, unknown>): number {
  const height = Number(element.height);
  return Number.isFinite(height) ? height : 0;
}

/** Repack text rows top-down; non-text elements keep their geometry. */
function packElements(
  elements: Array<Record<string, unknown>>,
  canvasHeight: number,
): Array<Record<string, unknown>> | null {
  const limit = canvasHeight - BOTTOM_MARGIN;
  const texts = elements
    .filter((element) => element.type === 'text')
    .sort((a, b) => Number(a.top) - Number(b.top));
  if (texts.length < 2) return elements.map((element) => ({ ...element }));
  const tops = new Map<string, number>();
  let cursor = HEADING_MARGIN;
  for (const element of texts) {
    tops.set(String(element.id), Math.round(cursor));
    cursor += rowHeight(element) + 10;
  }
  if (cursor > limit + 10) return null;
  return elements.map((element) => {
    const top = tops.get(String(element.id));
    return top === undefined ? { ...element } : { ...element, top };
  });
}

/**
 * Repack text rows into a non-overlapping vertical stack. Decorative elements
 * keep their geometry. Returns the scene only when something moved.
 */
export function reflowSceneRows(scene: Record<string, unknown>): Record<string, unknown> | null {
  if (scene.type !== 'slide') return null;
  const canvas = (scene.content as { canvas?: Canvas } | undefined)?.canvas;
  if (!canvas || !Array.isArray(canvas.elements)) return null;
  const viewportSize = Number(canvas.viewportSize) || 1000;
  const viewportRatio = Number(canvas.viewportRatio) || 0.5625;
  const canvasHeight = Math.round(viewportSize * viewportRatio);
  const packed = packElements(canvas.elements, canvasHeight);
  if (!packed) return null;
  let changed = false;
  for (let i = 0; i < canvas.elements.length; i += 1) {
    if (packed[i]!.top !== canvas.elements[i]!.top) changed = true;
  }
  if (!changed) return null;
  return {
    ...scene,
    content: { ...(scene.content as Record<string, unknown>), canvas: { ...canvas, elements: packed } },
  };
}

export function planSceneSplit(
  document: { outline?: unknown; scenes?: Array<Record<string, unknown>> },
  sceneId: string,
): SceneSplit | null {
  const scene = (document.scenes ?? []).find((entry) => entry.id === sceneId);
  if (!scene || scene.type !== 'slide') return null;
  const canvas = (scene.content as { canvas?: Canvas } | undefined)?.canvas;
  if (!canvas || !Array.isArray(canvas.elements)) return null;

  const viewportSize = Number(canvas.viewportSize) || 1000;
  const viewportRatio = Number(canvas.viewportRatio) || 0.5625;
  const canvasHeight = Math.round(viewportSize * viewportRatio);
  const available = canvasHeight - HEADING_MARGIN - BOTTOM_MARGIN;
  const textRows = canvas.elements.filter((element) => element.type === 'text');
  if (textRows.length < 2) return null;
  const total = textRows.reduce((sum, element) => sum + rowHeight(element) + 10, 0);
  if (total <= available) return null;

  // Prefer a split near the middle by height, but never leave the first slide
  // empty or hand the continuation a single trailing row.
  let cumulative = 0;
  let splitAt = 1;
  for (let i = 0; i < textRows.length - 1; i += 1) {
    cumulative += rowHeight(textRows[i]) + 10;
    if (cumulative >= total / 2) {
      splitAt = i + 1;
      break;
    }
  }
  const splitIds = new Set(textRows.slice(splitAt).map((element) => String(element.id)));
  if (splitIds.size === 0 || splitIds.size === textRows.length) return null;

  const firstElements = canvas.elements.filter(
    (element) => element.type !== 'text' || !splitIds.has(String(element.id)),
  );
  const secondElements = canvas.elements.filter(
    (element) => element.type === 'text' && splitIds.has(String(element.id)),
  );
  if (secondElements.length === 0) return null;
  const packedFirst = packElements(firstElements, canvasHeight);
  const packedSecond = packElements(secondElements, canvasHeight);
  if (!packedFirst || !packedSecond) return null;

  const outlines =
    ((document.outline as { outlines?: Array<Record<string, unknown>> } | undefined)?.outlines ??
      []) as Array<Record<string, unknown>>;
  const outline = outlines.find(
    (entry) => String(entry.id) === String((scene as { outlineId?: string }).outlineId),
  );
  const baseTitle = String(
    outline?.title ?? (scene as { title?: string }).title ?? 'Slide',
  );
  const continuationId = nanoid(10);
  const continuationSceneId = nanoid(10);
  const order = Number(scene.order) || 0;
  const outlineOrder = Number(outline?.order) || order;

  const continuation: Record<string, unknown> = {
    ...scene,
    id: continuationSceneId,
    stageId: scene.stageId,
    outlineId: continuationId,
    order: order + 0.5,
    title: `${baseTitle} (continued)`,
    content: {
      ...(scene.content as Record<string, unknown>),
      canvas: {
        ...canvas,
        elements: packedSecond,
      },
    },
  };
  const first: Record<string, unknown> = {
    ...scene,
    content: {
      ...(scene.content as Record<string, unknown>),
      canvas: { ...canvas, elements: packedFirst },
    },
  };
  const continuationOutline: Record<string, unknown> = {
    ...(outline ?? {}),
    id: continuationId,
    title: `${baseTitle} (continued)`,
    order: outlineOrder + 0.5,
    type: 'slide',
  };
  return { scene: first, continuation, continuationOutline };
}
