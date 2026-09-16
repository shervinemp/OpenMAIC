import {
  sanitizeSlidePlacement,
  validateSlidePlacement,
  type PlacementFinding,
} from '@openmaic/dsl';

export interface RelayoutMove {
  elementId: string;
  fromTop: number;
  toTop: number;
}

export interface RelayoutPlan {
  sceneId: string;
  sceneTitle: string;
  moved: RelayoutMove[];
  keptPinned: Array<{ id: string; reason: string }>;
  overflowRows: string[];
  fitsWithoutMerge: boolean;
  findingsBefore: Array<{ kind: string; severity: string; message: string }>;
  findingsAfter: Array<{ kind: string; severity: string; message: string }>;
}

type RectElement = {
  id: string;
  type: string;
  left: number;
  top: number;
  width: number;
  height: number;
  imageType?: string;
  textType?: string;
  text?: unknown;
  opacity?: number;
};

const PIN_GAP = 10;
const EDGE_MARGIN = 16;
const DEFAULT_FONT_PX = 14;
const LINE_HEIGHT_FACTOR = 1.5;
const PARAGRAPH_PAD = 12;

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function effectiveRowHeight(element: RectElement): number {
  const declared = element.height;
  if (element.type === 'text' && typeof (element as { content?: string }).content === 'string') {
    const content = (element as { content?: string }).content as string;
    const fontSizeMatch = /(?:font-size\s*:\s*)?(\d+(?:\.\d+)?)px/.exec(content);
    const fontSize = fontSizeMatch ? parseFloat(fontSizeMatch[1]) : DEFAULT_FONT_PX;
    const plain = stripHtml(content);
    const explicitLines = (content.match(/<br\s*\/?>/gi) ?? []).length;
    const charsPerLine = Math.max(8, Math.floor((element.width - 12) / (fontSize * 0.52)));
    const wrappedLines = Math.ceil(plain.length / charsPerLine) || 1;
    const lines = Math.max(explicitLines + 1, wrappedLines);
    const estimated = Math.ceil(lines * fontSize * LINE_HEIGHT_FACTOR + PARAGRAPH_PAD);
    if (estimated > 0 && estimated < declared) return estimated;
  }
  return declared;
}

function isPinned(element: RectElement, canvasArea: number): boolean {
  if (element.type === 'line') return true;
  if (element.type === 'image' && element.imageType === 'background') return true;
  if (element.width * element.height >= 0.9 * canvasArea) return true;
  if (element.type === 'shape' && element.text === undefined) return true;
  if (typeof element.opacity === 'number' && element.opacity < 0.25) return true;
  return false;
}

function pinReason(element: RectElement, canvasArea: number): string {
  if (element.type === 'line') return 'line';
  if (element.type === 'image' && element.imageType === 'background') return 'background image';
  if (element.width * element.height >= 0.9 * canvasArea) return 'full-bleed';
  if (element.type === 'shape') return 'decorative shape';
  return 'low-opacity overlay';
}

export function computeRelayoutPlan(scene: {
  id: string;
  title?: string;
  type?: string;
  content?: unknown;
}): RelayoutPlan | null {
  if ((scene as { type?: string }).type !== 'slide') return null;
  const canvas = (scene.content as { canvas?: { viewportSize?: number; viewportRatio?: number; elements?: RectElement[] } } | undefined)?.canvas;
  if (!canvas || !Array.isArray(canvas.elements)) return null;
  const viewportSize = typeof canvas.viewportSize === 'number' ? canvas.viewportSize : 1000;
  const viewportRatio = typeof canvas.viewportRatio === 'number' ? canvas.viewportRatio : 0.5625;
  const canvasHeight = Math.round(viewportSize * viewportRatio);
  const canvasArea = viewportSize * canvasHeight;

  const findingsBefore = findFindings(
    validateSlidePlacement({ viewportSize, viewportRatio, elements: canvas.elements as never }),
  );
  if (findingsBefore.length === 0) return null;

  const working: Array<{ element: RectElement; index: number }> = canvas.elements.map(
    (element, index) => ({ element: { ...element }, index }),
  );
  for (const entry of working) {
    const originalIndex = entry.index;
    const original = canvas.elements[originalIndex];
    entry.element = { ...original };
  }

  const pinnedEntries = working.filter((entry) => isPinned(entry.element, canvasArea));
  const pinnedBottom = pinnedEntries.reduce(
    (max, entry) => Math.max(max, entry.element.top + entry.element.height),
    0,
  );
  const contentTopStart = Math.max(pinnedBottom + PIN_GAP, 40);

  const movable = working
    .filter((entry) => !pinnedEntries.includes(entry))
    .sort((a, b) => a.element.top - b.element.top || a.index - b.index);

  const moved: RelayoutMove[] = [];
  const overflowRows: string[] = [];
  let cursor = contentTopStart;
  for (const entry of movable) {
    const { element } = entry;
    const rowHeight = effectiveRowHeight(element);
    if (cursor + rowHeight > canvasHeight - EDGE_MARGIN) {
      overflowRows.push(element.id);
      continue;
    }
    if (cursor !== element.top) {
      const toTop = Math.max(0, Math.round(cursor));
      moved.push({ elementId: element.id, fromTop: element.top, toTop });
    }
    cursor += rowHeight + PIN_GAP;
  }

  return {
    sceneId: scene.id,
    sceneTitle: scene.title ?? '',
    moved,
    keptPinned: pinnedEntries.map((entry) => ({ id: entry.element.id, reason: pinReason(entry.element, canvasArea) })),
    overflowRows,
    fitsWithoutMerge: overflowRows.length === 0,
    findingsBefore,
    findingsAfter: findingsBefore.map((finding) => ({
      kind: finding.kind,
      severity: finding.severity,
      message: finding.message,
    })),
  };
}

export function applyRelayoutMoves(
  scene: { content?: unknown },
  plan: RelayoutPlan,
): Array<{ elementId: string; fromTop: number; toTop: number }> {
  const canvas = (scene.content as { canvas?: { elements?: Array<Record<string, unknown>> } } | undefined)?.canvas;
  if (!canvas || !Array.isArray(canvas.elements)) return [];
  const applied: Array<{ elementId: string; fromTop: number; toTop: number }> = [];
  for (const move of plan.moved) {
    const element = canvas.elements.find((entry) => (entry as { id?: string }).id === move.elementId);
    if (!element) continue;
    const fromTop = element.top as number;
    element.top = move.toTop;
    applied.push({ elementId: move.elementId, fromTop, toTop: move.toTop });
  }
  return applied;
}

export function residualFindings(scene: { content?: unknown }): PlacementFinding[] {
  const canvas = (scene.content as { canvas?: { viewportSize?: number; viewportRatio?: number; elements?: unknown[] } } | undefined)?.canvas;
  if (!canvas || !Array.isArray(canvas.elements)) return [];
  return validateSlidePlacement({
    viewportSize: canvas.viewportSize ?? 1000,
    viewportRatio: canvas.viewportRatio ?? 0.5625,
    elements: canvas.elements as never,
  });
}

export function sanitizeSceneCanvas(scene: { content?: unknown }): number {
  const canvas = (scene.content as { canvas?: { viewportSize?: number; viewportRatio?: number; elements?: unknown[] } } | undefined)?.canvas;
  if (!canvas || !Array.isArray(canvas.elements)) return 0;
  return sanitizeSlidePlacement(canvas as never).changes.length;
}

function findFindings(findings: PlacementFinding[]) {
  return findings.map((finding) => ({
    kind: finding.kind,
    severity: finding.severity,
    message: finding.message,
  }));
}

export interface LayoutLedgerStatus {
  /** Residual error-severity findings after repair (0 = green, write-off). */
  errors: number;
  /** Residual warn-severity findings (advisory, never blocks). */
  warnings: number;
  /** Epoch ms of the last status-producing maintenance pass. */
  checkedAt: number;
}

/**
 * Red/green doctrine for the layout-debt ledger: a scene only carries
 * `layoutStatus` when a maintenance pass actually inspected it. `errors: 0`
 * is the green state; any nonzero count keeps the scene on the debt list.
 * Set on the scene object in place (extra fields pass validation and the
 * store persists scenes verbatim).
 */
export function applyLayoutLedger(
  scene: { content?: unknown },
  findings: PlacementFinding[],
): LayoutLedgerStatus {
  const status: LayoutLedgerStatus = {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warn').length,
    checkedAt: Date.now(),
  };
  (scene as { layoutStatus?: unknown }).layoutStatus = status;
  return status;
}

/** Existing debt marker on a scene, when a past pass wrote one. */
export function layoutLedgerOf(scene: unknown): LayoutLedgerStatus | null {
  const value = (scene as { layoutStatus?: unknown } | null)?.layoutStatus;
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { errors?: unknown }).errors === 'number' &&
    typeof (value as { warnings?: unknown }).warnings === 'number' &&
    typeof (value as { checkedAt?: unknown }).checkedAt === 'number'
  ) {
    return value as LayoutLedgerStatus;
  }
  return null;
}

/** Findings from the scene's own hole (validator output) with no context. */
export function scenePlacementFindings(scene: { content?: unknown }): PlacementFinding[] {
  return residualFindings(scene);
}
