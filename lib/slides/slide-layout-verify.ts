import {
  sanitizeSlidePlacement,
  validateSlidePlacement,
  type PlacementFinding,
  type SlideContent,
} from '@openmaic/dsl';

const DEFAULT_REPAIR_CALL_LIMIT = 256;

let repairCallsUsed = 0;

function repairCallLimit(): number {
  if (typeof window === 'undefined') return DEFAULT_REPAIR_CALL_LIMIT;
  const override = (window as typeof window & { __OPENMAIC_REPAIR_CALL_LIMIT__?: number })
    .__OPENMAIC_REPAIR_CALL_LIMIT__;
  return typeof override === 'number' && override > 0 ? Math.floor(override) : DEFAULT_REPAIR_CALL_LIMIT;
}

const RECT_FIELDS = ['left', 'top', 'width', 'height'] as const;

export interface SlideLayoutResult {
  content: SlideContent;
  clamped: number;
  findings: PlacementFinding[];
  repaired: boolean;
  repairFailed: boolean;
  repairError?: string;
}

interface CanvasLike {
  viewportSize: number;
  viewportRatio: number;
  elements: Array<Record<string, unknown>>;
}

export function applyLayoutPatch(
  canvas: CanvasLike,
  patchedElementList: Array<Record<string, unknown>>,
): boolean {
  const sourceById = new Map<string, Record<string, unknown>>();
  for (const element of canvas.elements) {
    if (typeof element.id !== 'string') return false;
    sourceById.set(element.id, element);
  }
  if (patchedElementList.length !== canvas.elements.length) return false;
  if (!patchedElementList.every((element) => sourceById.has(element.id as string))) return false;
  canvas.elements = patchedElementList.map((patched) => {
    const source = sourceById.get(patched.id as string);
    const next = { ...source };
    for (const field of RECT_FIELDS) {
      const value = patched[field];
      if (typeof value !== 'number') continue;
      if ((field === 'width' || field === 'height') && field in next) {
        const original = next[field] as number;
        // A move only: the patch may resize at most ±20% — anything else
        // signals the model is cheating geometry to dodge an overlap.
        if (value < original * 0.8 || value > original * 1.2) return { ...source };
        if (value <= 0) return { ...source };
      }
      next[field] = value;
    }
    return next;
  });
  return true;
}

export async function verifyAndRepairSlideLayout(
  content: unknown,
): Promise<SlideLayoutResult> {
  const slide = content as { type?: string; canvas?: CanvasLike } | null;
  const canvas = slide?.type === 'slide' ? slide.canvas : undefined;
  if (!canvas || !Array.isArray(canvas.elements)) {
    return { content: content as SlideContent, clamped: 0, findings: [], repaired: false, repairFailed: false };
  }

  const clamp = sanitizeSlidePlacement(canvas as never);
  let findings = validateSlidePlacement({ viewportSize: canvas.viewportSize, viewportRatio: canvas.viewportRatio, elements: canvas.elements as never });
  let repaired = false;
  let repairFailed = false;
  let repairError: string | undefined;

  if (findings.length > 0 && repairCallsUsed < repairCallLimit()) {
    repairCallsUsed += 1;
    try {
      const response = await fetch('/api/generate/scene-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene: { type: 'slide', content },
          intent: 'layout-repair',
          geometryFindings: findings,
        }),
      });
      if (response.ok) {
        const body = (await response.json()) as {
          layoutPatch?: { elements?: Array<Record<string, unknown>> };
        };
        const elements = body.layoutPatch?.elements;
        if (!Array.isArray(elements)) {
          repairFailed = true;
          repairError = 'layout server returned no element list';
        } else if (!applyLayoutPatch(canvas, elements)) {
          repairFailed = true;
          repairError = 'layout patch violated the element id contract';
        } else {
          sanitizeSlidePlacement(canvas as never);
          repaired = true;
        }
      } else {
        repairFailed = true;
        repairError = 'layout server error ' + response.status;
      }
    } catch (error) {
      repairFailed = true;
      repairError = error instanceof Error ? error.message : String(error);
    }
    findings = validateSlidePlacement({ viewportSize: canvas.viewportSize, viewportRatio: canvas.viewportRatio, elements: canvas.elements as never });
    if (findings.some((finding) => finding.severity === 'error')) {
      repairFailed = true;
      repairError ??= 'validator still errors after the layout patch';
    }
  } else if (findings.some((finding) => finding.severity === 'error')) {
    repairFailed = true;
    repairError = 'layout repair budget exhausted';
  }

  return {
    content: content as SlideContent,
    clamped: clamp.changes.length,
    findings,
    repaired,
    repairFailed,
    repairError,
  };
}
