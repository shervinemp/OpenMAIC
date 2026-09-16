import { sanitizeSlidePlacement } from '@openmaic/dsl';
import { computeSplitPlan } from './split-plan';

/**
 * Atomic split-apply for layout-debt scenes — the self-healing terminal:
 * the deterministic pass fills first, the bounded layout patch fills second,
 * and whatever STILL holds occlusion errors is split across canvases.
 * Never red-carded, never completion-gating, zero LLM.
 *
 * Whole-document surgery: scenes + outline entries + lesson-group jobs
 * change together in memory; the caller persists with ONE `saveDocument`,
 * so the deck-completeness invariant (every outline has its scene at the
 * matching order) never gaps mid-flight.
 *
 * Faithfulness contract (no silent rewrites):
 *   - element rows are used VERBATIM (ids, content untouched); positions
 *     only get the deterministic vertical re-stack on a canvas that fits;
 *   - pinned/decorative elements repeat on every chunk (frame identical);
 *   - actions redistribute exactly how the plan stage mapped them (anchor
 *     rule + nearest-anchor interpolation), never re-authored;
 *   - part outlines inherit every field of the original except id, title,
 *     order; the only synthesized fields are bookkeeping (ids, orders,
 *     empty phase envelopes — they ARE the materialized work).
 */

export interface SplitApplyPart {
  outlineId: string;
  order: number;
  elementCount: number;
  actionCount: number;
}

export interface SplitApplyResult {
  sceneId: string;
  title: string;
  originalOrder: number;
  partOutlineIds: string[];
  partSceneIds: string[];
  parts: SplitApplyPart[];
  shiftedFromOrder: number;
  shiftedCount: number;
}

export interface SplitApplyDocumentShape {
  stage: { id: string; [key: string]: unknown };
  scenes: Array<Record<string, unknown>>;
  outline: {
    outlines: Array<Record<string, unknown>>;
    lessonGroups: Array<{ lessonId: string; jobs?: Array<Record<string, unknown>> }>;
    generationComplete: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const FIRST_ROW_TOP = 40;
const PIN_GAP = 10;

function canvasOf(scene: Record<string, unknown>): { viewportSize: number; viewportRatio: number; elements: Array<Record<string, unknown>> } | null {
  const content = scene.content as { type?: string; canvas?: { viewportSize?: number; viewportRatio?: number; elements?: Array<Record<string, unknown>> } } | null;
  if (!content || content.type !== 'slide' || !content.canvas || !Array.isArray(content.canvas.elements)) return null;
  return {
    viewportSize: content.canvas.viewportSize ?? 1000,
    viewportRatio: content.canvas.viewportRatio ?? 0.5625,
    elements: content.canvas.elements,
  };
}

export function canSplit(scene: Record<string, unknown>): boolean {
  if (scene.type !== 'slide') return false;
  const plan = computeSplitPlan(scene as never);
  return !!plan && plan.chunks.length > 1;
}

function isPinned(element: Record<string, unknown>, canvasArea: number, canvasHeight: number): boolean {
  if (element.type === 'line') return true;
  if (element.type === 'image' && (element as { imageType?: string }).imageType === 'background') return true;
  if ((element.width as number) * (element.height as number) >= 0.9 * canvasArea) return true;
  // FRAME-ONLY doctrine (matches the plan stage): only edge-hugging shapes
  // join the repeated frame; interior shapes are content — diagrams become
  // rows and ride their chunk, so parts don't occlude their own text.
  if (element.type === 'shape') {
    const top = (element.top as number) ?? 0;
    const bottomEdge = top + ((element.height as number) ?? 0);
    return top <= 8 || canvasHeight - bottomEdge <= 8 || ((element.left as number) ?? 0) <= 8;
  }
  if (typeof (element as { opacity?: number }).opacity === 'number' && (element as { opacity?: number }).opacity! < 0.25) return true;
  return false;
}

/** Verbatim rows re-stacked for one chunk canvas + the pinned frame repeated. */
export function buildChunkCanvas(
  canvas: { viewportSize: number; viewportRatio: number; elements: Array<Record<string, unknown>> },
  chunk: { elementIds: string[] },
): { viewportSize: number; viewportRatio: number; elements: Array<Record<string, unknown>> } | null {
  if (!canvas || !Array.isArray(canvas.elements)) return null;
  const canvasHeight = Math.round(canvas.viewportSize * canvas.viewportRatio);
  const canvasArea = canvas.viewportSize * canvasHeight;
  const pinned = canvas.elements.filter((entry) => isPinned(entry, canvasArea, canvasHeight));
  const chunkSet = new Set(chunk.elementIds);
  const chunkRows = canvas.elements.filter((entry) => chunkSet.has(entry.id as string));
  let cursor = FIRST_ROW_TOP;
  const positioned: Array<Record<string, unknown>> = [];
  for (const row of chunkRows) {
    const height = Math.max(1, Math.round((row.height as number) || 50));
    positioned.push({ ...row, top: cursor });
    cursor += height + PIN_GAP;
  }
  void canvasHeight; void canvasArea;
  return {
    viewportSize: canvas.viewportSize,
    viewportRatio: canvas.viewportRatio,
    elements: [...pinned, ...positioned],
  };
}

/** Apply ONE split plan onto an in-memory document. Caller persists atomically. */
export function applySplit(
  document: SplitApplyDocumentShape,
  sceneId: string,
): SplitApplyResult | null {
  const sceneIndex = document.scenes.findIndex((s) => s.id === sceneId && s.type === 'slide');
  if (sceneIndex < 0) return null;
  const scene = document.scenes[sceneIndex];
  const plan = computeSplitPlan(scene as never);
  if (!plan || plan.chunks.length <= 1) return null;

  const canvas = canvasOf(scene);
  if (!canvas) return null;
  const originalOrder = scene.order as number;
  const outlineId = scene.outlineId as string;
  const outlineSource = document.outline.outlines.find((entry) => (entry as { id?: string }).id === outlineId);
  if (!outlineSource) return null;
  const outlineRecord: Record<string, unknown> = { ...outlineSource };

  const actionById = new Map<string, Record<string, unknown>>();
  for (const action of ((scene.actions ?? []) as Array<Record<string, unknown>>)) {
    actionById.set(String(action.id), action);
  }

  const partOutlineIds: string[] = [];
  const partSceneIds: string[] = [];
  const parts: SplitApplyPart[] = [];
  const newScenes: Array<Record<string, unknown>> = [];
  const newOutlines: Array<Record<string, unknown>> = [];

  plan.chunks.forEach((chunk, partIndex) => {
    const isFirst = partIndex === 0;
    const partOutlineId = isFirst ? outlineId : `${outlineId}__p${partIndex + 1}`;
    const partSceneId = isFirst ? String(scene.id) : `${String(scene.id)}__p${partIndex + 1}`;
    const order = originalOrder + partIndex;

    const chunkContent = buildChunkCanvas(canvas, chunk);
    sanitizeSlidePlacement(chunkContent as never);

    const actions = chunk.actionIds
      .map((id) => actionById.get(id))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));

    const partScene: Record<string, unknown> = {
      ...scene,
      id: partSceneId,
      outlineId: partOutlineId,
      order,
      title: chunk.title,
      content: {
        type: 'slide',
        canvas: chunkContent,
        schemaVersion: (scene.content as { schemaVersion?: number } | undefined)?.schemaVersion ?? 1,
      },
      actions,
      createdAt: (scene.createdAt as number) ?? Date.now(),
      updatedAt: Date.now(),
    };

    const partOutline: Record<string, unknown> = {
      ...outlineRecord,
      id: partOutlineId,
      order,
      title: chunk.title,
    };

    parts.push({
      outlineId: partOutlineId,
      order,
      elementCount: chunk.elementIds.length,
      actionCount: actions.length,
    });
    partOutlineIds.push(partOutlineId);
    partSceneIds.push(partSceneId);
    newScenes.push(partScene);
    newOutlines.push(partOutline);
  });

  if (newScenes.length < 2) return null;

  document.scenes.splice(sceneIndex, 1, ...newScenes);

  const outlineEntryIndex = document.outline.outlines.findIndex((entry) => (entry as { id?: string }).id === outlineId);
  if (outlineEntryIndex >= 0) document.outline.outlines.splice(outlineEntryIndex, 1, ...newOutlines);

  const shift = plan.chunks.length - 1;
  let shifted = 0;
  if (shift > 0) {
    for (const entry of document.scenes) {
      if (partSceneIds.includes(String(entry.id))) continue;
      const order = entry.order as number;
      if (typeof order === 'number' && order > originalOrder) {
        entry.order = order + shift;
        shifted += 1;
      }
    }
    for (const entry of document.outline.outlines) {
      if (partOutlineIds.includes(String(entry.id))) continue;
      const order = (entry as { order?: number }).order;
      if (typeof order === 'number' && order > originalOrder) {
        (entry as { order: number }).order = order + shift;
        shifted += 1;
      }
    }
  }

  // LESSON GROUPS: 1 job per outline keeps the load-time recovery scan and
  // the generation terminal pointing at already-materialized work. Phase
  // envelopes are marked done — the part IS the materialized rows, content
  // and actions arrived verbatim from the original scene — so the generation
  // panel does not render the parts as bare pending envelopes.
  const lessonId = (outlineRecord as { lessonId?: string }).lessonId;
  const group = (document.outline.lessonGroups.find((g) => g.lessonId === lessonId) ?? null) as { lessonId: string; jobs?: Array<Record<string, unknown>> } | null;
  if (group) {
    group.jobs = (group.jobs ?? []).filter((job) => job.outlineId !== outlineId);
    const now = Date.now();
    for (const part of parts) {
      group.jobs.push({
        outlineId: part.outlineId,
        phases: {
          content: { status: 'done', attempts: 1, updatedAt: now },
          actions: { status: 'done', attempts: 1, updatedAt: now },
          layout: { status: 'done', attempts: 1, updatedAt: now },
        },
      });
    }
  }

  return {
    sceneId,
    title: plan.chunks[0]?.title ?? '',
    originalOrder,
    partOutlineIds,
    partSceneIds,
    parts,
    shiftedFromOrder: originalOrder,
    shiftedCount: shifted,
  };
}

export { computeSplitPlan };
