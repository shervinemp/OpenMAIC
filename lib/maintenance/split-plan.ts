import { sanitizeSlidePlacement, validateSlidePlacement } from '@openmaic/dsl';

/**
 * Scene-split planning for mega-canvas slide scenes (token-free, content-
 * preserving). A debt scene whose rows cannot fit even after the lossless
 * move-only pass gets split across the vertical axis into N fits-in-canvas
 * page chunks — each chunk keeps its exact original rows (elements verbatim,
 * ids unchanged), pinned/decorative elements repeat on every chunk so the
 * canvas frame is identical, and anchored actions (spotlight/laser with an
 * elementId) follow their element. Unanchored speech/laser actions ride the
 * chunk of the next anchored action that follows them in playback order
 * (nearest-anchor interpolation) — the same element the narrator's next
 * spotlight points at bound them to, page-boundary adjustments are faithful
 * to playback flow rather than a re-lecture rewrite.
 *
 * NOTE (apply treaty, not this module's job): APPLYING a split is whole-
 * document surgery — new scenes need unique orders (renumbering everything
 * after), new outline entries (doc.outline.outlines) and lesson-group jobs so
 * the deck-completeness invariant stays true. `computeSplitPlan` is the pure
 * read side; the apply half belongs in an atomic saveDocument pass reviewed
 * against the dry-run plan — never per-scene putScene.
 */

export interface SplitPlanChunk {
  title: string;
  /** Verbatim element ids on this chunk, in original canvas order. */
  elementIds: string[];
  /** Action ids that play on this chunk (anchored + interpolated). */
  actionIds: string[];
  fitsWithoutMerge: boolean;
}

export interface SplitPlan {
  sceneId: string;
  title: string;
  order: number;
  chunks: SplitPlanChunk[];
  /** Verbatim explanation of why the deterministic pass alone cannot cure it. */
  reason: string;
}

interface RectElement {
  id: string;
  type: string;
  left: number;
  top: number;
  width: number;
  height: number;
  imageType?: string;
  text?: unknown;
  opacity?: number;
  content?: string;
}

const PIN_GAP = 10;
const EDGE_MARGIN = 16;
const DEFAULT_FONT_PX = 14;
const LINE_HEIGHT_FACTOR = 1.5;
const PARAGRAPH_PAD = 12;

export interface RowLayout {
  pinnedIds: string[];
  /** Content rows bottom→top in original canvas order, one entry per row. */
  rows: Array<{ id: string; originalTop: number; estimatedHeight: number }>;
  canvasHeight: number;
  viewportSize: number;
  viewportRatio: number;
}

export function computeRowLayout(content: unknown): RowLayout | null {
  const slide = (content ?? null) as { type?: string; canvas?: { viewportSize?: number; viewportRatio?: number; elements?: RectElement[] } } | null;
  const canvas = slide?.type === 'slide' ? slide.canvas : undefined;
  if (!canvas || !Array.isArray(canvas.elements) || canvas.elements.length === 0) return null;
  const viewportSize = typeof canvas.viewportSize === 'number' ? canvas.viewportSize : 1000;
  const viewportRatio = typeof canvas.viewportRatio === 'number' ? canvas.viewportRatio : 0.5625;
  const canvasHeight = Math.round(viewportSize * viewportRatio);
  const canvasArea = viewportSize * canvasHeight;

  const pinnedIds: string[] = [];
  const rows: RowLayout['rows'] = [];
  for (const element of canvas.elements) {
    if (isPinned(element, canvasArea)) {
      pinnedIds.push(element.id);
      continue;
    }
    const top = typeof element.top === 'number' ? element.top : 0;
    // Height truth first: the element's declared height for non-text; for
    // text rows the content-height estimator makes packed rows safe (the
    // declared grid height underestimates wrapped text).
    const declared = typeof element.height === 'number' ? element.height : 0;
    const estimated = declared > 0 ? declared : estimatedRowHeight(element);
    rows.push({ id: element.id, originalTop: top, estimatedHeight: Math.max(1, estimated) });
  }
  rows.sort((a, b) => a.originalTop - b.originalTop);
  return {
    pinnedIds,
    rows,
    canvasHeight,
    viewportSize,
    viewportRatio,
  };
}

function isPinned(element: RectElement, canvasArea: number): boolean {
  if (element.type === 'line') return true;
  if (element.type === 'image' && element.imageType === 'background') return true;
  if (element.width * element.height >= 0.9 * canvasArea) return true;
  if (element.type === 'shape' && element.text === undefined) return true;
  if (typeof element.opacity === 'number' && element.opacity < 0.25) return true;
  return false;
}

function estimatedRowHeight(element: RectElement): number {
  if (element.type === 'text' && typeof element.content === 'string') {
    const fontSizeMatch = /(?:font-size\s*:\s*)?(\d+(?:\.\d+)?)px/.exec(element.content);
    const fontSize = fontSizeMatch ? parseFloat(fontSizeMatch[1]) : DEFAULT_FONT_PX;
    const plain = element.content.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const explicitLines = (element.content.match(/<br\s*\/?>/gi) ?? []).length;
    const charsPerLine = Math.max(8, Math.floor(((element.width ?? 100) - 12) / (fontSize * 0.52)));
    const wrappedLines = Math.ceil(plain.length / charsPerLine) || 1;
    return Math.ceil(Math.max(explicitLines + 1, wrappedLines) * fontSize * LINE_HEIGHT_FACTOR + PARAGRAPH_PAD);
  }
  return 50;
}

interface AnchoredAction {
  id: string;
  elementId?: string;
  type: string;
}

export function computeSplitPlan(scene: {
  id: string;
  title?: string;
  order?: number;
  type?: string;
  content?: unknown;
  actions?: Array<{ id: string; type: string; elementId?: string }>;
}): SplitPlan | null {
  if (scene.type !== 'slide') return null;
  const layout = computeRowLayout(scene.content);
  if (!layout) return null;
  const findings = validateSlidePlacement({
    viewportSize: layout.viewportSize,
    viewportRatio: layout.viewportRatio,
    elements: sceneContentElements(scene.content) as never,
  });
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  if (errorCount === 0) return null; // nothing to split

  const workingIds = new Set(layout.rows.map((r) => r.id));
  // Greedy sequential packing: rows in original order, each chunk as full as
  // the canvas allows, so the plan is deterministic regardless of run count.
  const chunksById = new Array<Set<string>>();
  let cursor = 40;
  let current = new Set<string>();
  for (const row of layout.rows) {
    if (cursor + row.estimatedHeight + PIN_GAP > layout.canvasHeight - EDGE_MARGIN) {
      chunksById.push(current);
      current = new Set();
      cursor = 40;
    }
    current.add(row.id);
    cursor += row.estimatedHeight + PIN_GAP;
  }
  if (current.size > 0) chunksById.push(current);
  if (chunksById.length <= 1) {
    return {
      sceneId: scene.id,
      title: scene.title ?? '',
      order: scene.order ?? -1,
      chunks: [],
      reason: 'single chunk but error findings remain — needs the regression pass, not the splitter',
    } satisfies SplitPlan;
  }

  const idToChunk = new Map<string, number>();
  chunksById.forEach((chunk, index) => {
    for (const id of chunk) idToChunk.set(id, index);
  });

  // Anchor actions (elementId present and mapped) and interpolate speeches.
  const actions = scene.actions ?? [];
  const anchored: Array<{ index: number; actionIndex: number; elementId: string }> = [];
  actions.forEach((action, actionIndex) => {
    if (typeof action.elementId === 'string' && idToChunk.has(action.elementId)) {
      anchored.push({ index: actionIndex, actionIndex, elementId: action.elementId });
    }
  });
  const chunkActions = chunksById.map(() => [] as string[]);
  let anchorIndex = 0;
  actions.forEach((action) => {
    let chunk: number | undefined;
    if (typeof action.elementId === 'string') {
      chunk = idToChunk.get(action.elementId);
    }
    if (chunk === undefined) {
      // Interpolate: chunk of the next anchored action (or the last anchor
      // after trailing unanchored actions).
      const presenter: { index: number; elementId: string } | undefined =
        anchored[anchorIndex] ?? [...anchored].pop();
      chunk = presenter ? idToChunk.get(presenter.elementId) : undefined;
    }
    if (typeof action.elementId === 'string' && idToChunk.has(action.elementId)) anchorIndex += 1;
    if (chunk === undefined) chunk = 0;
    chunkActions[chunk].push(action.id);
  });

  const baseTitle = scene.title ?? scene.id;
  return {
    sceneId: scene.id,
    title: baseTitle,
    order: scene.order ?? -1,
    chunks: chunksById.map((chunk, index) => ({
      title: index === 0 ? baseTitle : `${baseTitle} (part ${index + 1})`,
      elementIds: [...chunk],
      actionIds: chunkActions[index],
      fitsWithoutMerge: true,
    })),
    reason: `scene stacks ${workingIds.size} content rows across ${chunksById.length} canvases after deterministic repair (${errorCount} occlusion errors)`,
  };
}

function sceneContentElements(content: unknown): Array<Record<string, unknown>> {
  const canvas = (content as { canvas?: { elements?: Array<Record<string, unknown>> } } | undefined)?.canvas;
  return canvas?.elements ?? [];
}

export function planSummary(plan: SplitPlan): string {
  return `${plan.chunks.length} chunk(s): ` + plan.chunks.map((chunk, i) => `p${i + 1}[${chunk.elementIds.length} rows, ${chunk.actionIds.length} actions]`).join(' ');
}

export { validateSlidePlacement, sanitizeSlidePlacement };
export type { RectElement };
