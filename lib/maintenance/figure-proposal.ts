import type { callLLM } from '@/lib/ai/llm';

/**
 * Figure-gap proposals — the propose-and-confirm tier for "the title promises
 * a diagram; the canvas is text chips". The judge emits a TYPED shape layout
 * (boxes/spokes/labels only, no prose rewrite), every proposal is
 * geometry-validated with the same placement validator the maintenance passes
 * use, and adoption is always human-confirmed — a wrong diagram actively
 * miseducates, so this tier never auto-applies.
 */

const stripHtml = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const PROPOSAL_SYSTEM_PROMPT = [
  'You propose a SMALL DIAGRAM to add to one course slide whose title promises a shape/diagram (e.g. "Star Schema", "Architecture at a Glance") but whose canvas currently holds only scattered text rows.',
  'Hard rules:',
  '- Propose shapes ONLY from: box (a rectangle node), line (a connector/edge). Optionally give each shape a very short label (2-6 words, derived from the slide\'s own terminology; do NOT invent new terminology).',
  '- Coordinates are absolute canvas pixels: the viewport is 1000 wide.; place ALL shapes in the canvas body band between y=150 and y=520, x between [40,960].',
  '- Shape ids: prefix every id with `fig_` so it cannot collide with existing element ids.',
  '- The diagram must NOT overlap any existing text row (their rects are supplied). Compose inside a free rectangle; DO NOT cover existing content.',
  '- Keep it simple: at most 2 boxes per row, maximum 8 shapes total. Star-schema-like: one central fact box, spokes outward to dimension boxes, lines connecting.',
  '- If the slide genuinely cannot accept a diagram (no free band), return {"shapes":[],"reason":"…"}',
  'Return STRICT JSON: {"labelsWhenNeeded":true,"shapes":[{"id":"fig_centerBox","kind":"box","left":400,"top":260,"width":200,"height":90,"label":"fact_sales"}],"reason":"…"}',
].join('\n');

function buildRequest(scene: {
  id: string;
  title: string;
  content?: { canvas?: { viewportSize?: number; viewportRatio?: number; elements?: ReadonlyArray<Record<string, unknown>> } };
}, figureGapReason?: string): string {
  const canvas = scene.content?.canvas;
  const existing = (canvas?.elements ?? []).map((el) => ({
    id: (el as { id?: string }).id,
    kind: (el as { type?: string }).type,
    left: Number((el as { left?: number }).left ?? 0),
    top: Number((el as { top?: number }).top ?? 0),
    width: Number((el as { width?: number }).width ?? 0),
    height: Number((el as { height?: number }).height ?? 0),
    text: stripHtml(String((el as { content?: string }).content ?? '')).slice(0, 120),
  }));
  return JSON.stringify({
    sceneId: scene.id,
    title: scene.title,
    figureGapDetection: figureGapReason ?? '',
    existingElements: existing,
  });
}

export interface ProposedShape {
  id: string;
  kind: 'box' | 'line';
  left: number;
  top: number;
  width: number;
  height: number;
  label?: string;
  fill?: string;
}

export interface FigureProposal {
  sceneId: string;
  title: string;
  shapes: ProposedShape[];
  reason?: string;
}

export interface ProposalOutcome {
  proposal: FigureProposal | null;
  error?: string;
}

export interface ProposalBudget {
  used: number;
  limit: number;
}

export function budgetCrossed(budget: ProposalBudget): boolean {
  return budget.used >= budget.limit;
}

const BODY_TOP = 150;
const BODY_BOTTOM = 540;
const MAX_SHAPES = 8;

function validatePolicyProposal(shapes: unknown, taken: Set<string>): { ok: boolean; error?: string } {
  if (!Array.isArray(shapes) || shapes.length === 0) {
    return { ok: false, error: 'model proposed no shapes' };
  }
  if (shapes.length > MAX_SHAPES) return { ok: false, error: 'too many shapes (budget 8)' };
  const ids = new Set<string>();
  for (const shape of shapes) {
    const entry = shape as Partial<ProposedShape> & { kind?: string; id?: string };
    if (typeof entry.id !== 'string' || !entry.id) return { ok: false, error: 'missing shape id' };
    if ((entry.id as string).startsWith('fig_') === false) {
      return { ok: false, error: `id "${entry.id}" lacks the fig_ prefix` };
    }
    if (taken.has(entry.id)) return { ok: false, error: `id "${entry.id}" collides with an existing element` };
    if (ids.has(entry.id)) return { ok: false, error: 'duplicate proposal id' };
    ids.add(entry.id);
    if (entry.kind !== 'box' && entry.kind !== 'line')
      return { ok: false, error: `kind ${String(entry.kind)} not allowed (box or line)` };
    for (const key of ['left', 'top', 'width', 'height'] as const) {
      const value = Number((entry as Record<string, unknown>)[key]);
      if (!Number.isFinite(value)) return { ok: false, error: `non-finite ${key}` };
    }
    if (entry.top! < BODY_TOP - 8 || entry.top! > BODY_BOTTOM)
      return { ok: false, error: `top ${entry.top} outside the body band` };
    if (entry.left! < 40 - 8 || entry.left! > 960) return { ok: false, error: 'outside the body band' };
    if (entry.width! <= 0 || entry.height! < 0) return { ok: false, error: 'degenerate shape' };
  }
  return { ok: true };
}

export async function proposeFigure(params: {
  scene: {
    id: string;
    title: string;
    content?: { canvas?: { viewportSize?: number; viewportRatio?: number; elements?: ReadonlyArray<Record<string, unknown>> } };
  };
  figureGapReason?: string;
  callLLMImpl: typeof callLLM;
  model: Parameters<typeof callLLM>[0] extends { model: infer M } ? M : string;
  thinkingConfig?: unknown;
}): Promise<ProposalOutcome> {
  const { scene, callLLMImpl, model, thinkingConfig } = params;
  try {
    const result = await callLLMImpl(
      {
        model,
        system: PROPOSAL_SYSTEM_PROMPT,
        prompt: buildRequest(scene as never, params.figureGapReason),
        maxOutputTokens: 4096,
        maxRetries: 0,
      } as never,
      'scene-verify',
      undefined,
      thinkingConfig ?? undefined,
    );
    const text = result.text ?? '';
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd <= jsonStart) {
      return { proposal: null, error: `unparsable response (finishReason: ${(result as { finishReason?: string }).finishReason})` };
    }
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as { shapes?: unknown; reason?: unknown };
    if (!Array.isArray(parsed.shapes) || parsed.shapes.length === 0) {
      return { proposal: null, error: 'model declined (no free band or no shapes)' };
    }
    const existingIds = new Set(
      (scene.content?.canvas?.elements ?? []).map((el) => (el as { id?: string }).id),
    );
    const check = validatePolicyProposal(parsed.shapes as Partial<ProposedShape>[], existingIds as Set<string>);
    if (!check.ok) {
      return { proposal: null, error: `proposal rejected: ${check.error}` };
    }
    const shapes = parsed.shapes.map((raw) => {
      const entry = raw as Partial<ProposedShape>;
      const shape: ProposedShape = {
        id: entry.id as string,
        kind: entry.kind as 'box' | 'line',
        left: Number(entry.left),
        top: Number(entry.top),
        width: Number(entry.width),
        height: Number(entry.height),
      };
      if (typeof entry.label === 'string' && entry.label) shape.label = entry.label;
      return shape;
    });
    return {
      proposal: {
        sceneId: scene.id,
        title: scene.title,
        shapes,
        ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
      },
    };
  } catch (error) {
    return { proposal: null, error: (error as Error)?.message?.slice(0, 200) ?? String(error) };
  }
}

export { PROPOSAL_SYSTEM_PROMPT };
