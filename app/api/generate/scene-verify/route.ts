import { NextRequest } from 'next/server';
import {
  sanitizeSlidePlacement,
  validateSlidePlacement,
  type PlacementFinding,
} from '@openmaic/dsl';
import { callLLM } from '@/lib/ai/llm';
import { buildVisionUserContent } from '@openmaic/generation';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { apiError, apiSuccess } from '@/lib/server/api-response';

interface VerifyRequestBody {
  scene: unknown;
  screenshot?: string;
  mode?: 'check' | 'repair';
  language?: string;
}

function extractSlideCanvas(scene: unknown): {
  viewportSize: number;
  viewportRatio: number;
  elements: Record<string, unknown>[];
} | null {
  if (!scene || typeof scene !== 'object') return null;
  const record = scene as Record<string, unknown>;
  if (record.type !== 'slide') return null;
  const content = record.content as Record<string, unknown> | undefined;
  const canvas = content?.canvas as Record<string, unknown> | undefined;
  if (!canvas || !Array.isArray(canvas.elements)) return null;
  return {
    viewportSize: typeof canvas.viewportSize === 'number' ? canvas.viewportSize : 1000,
    viewportRatio: typeof canvas.viewportRatio === 'number' ? canvas.viewportRatio : 0.5625,
    elements: canvas.elements as Record<string, unknown>[],
  };
}

const VERIFY_SYSTEM_PROMPT = [
  'You are a slide-layout quality judge for generated course slides.',
  'You receive one slide rendered as a screenshot (possibly) plus the raw element list.',
  '',
  'Report ONLY defects that a viewer would notice, as a strict JSON array:',
  '[{"kind":"overlap|organization|cut-off|visual","severity":"error|warn","message":"short why","elementIds":["..."]}]',
  '',
  'Legal layering (NOT defects): decorative accent shapes that mostly sit behind text,',
  'full-bleed backgrounds, low-opacity tint overlays, deliberate staggered cards.',
  'Focus on: text hidden by shapes, cut-off text at edges, elements colliding awkwardly,',
  'sections badly ordered or duplicated. Max 8 findings, most severe first.',
  'Answer with ONLY the JSON array (empty array if the slide is clean).',
].join('\n');

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as VerifyRequestBody;
    const canvas = extractSlideCanvas(body.scene);
    if (!canvas) return apiError('INVALID_REQUEST', 400, 'scene must be a slide scene');

    const geometryFindings: PlacementFinding[] = validateSlidePlacement({
      viewportSize: canvas.viewportSize,
      viewportRatio: canvas.viewportRatio,
      elements: canvas.elements as never[],
    });

    if (body.mode === 'repair') {
      const { changes } = sanitizeSlidePlacement(body.scene as never);
      return apiSuccess({
        sanitized: body.scene,
        sanitizeChanges: changes,
        geometryFindings: validateSlidePlacement({
          viewportSize: canvas.viewportSize,
          viewportRatio: canvas.viewportRatio,
          elements: canvas.elements as never[],
        }),
      });
    }

    const semanticFindings: unknown[] = [];
    if (body.screenshot) {
      const { model, thinkingConfig } = await resolveModelFromRequest(
        req,
        body as never,
        'scene-verify',
      );
      const elementSummary = JSON.stringify(
        canvas.elements.map((element) => ({
          id: element.id,
          type: element.type,
          left: element.left,
          top: element.top,
          width: element.width,
          height: element.height,
          rotate: element.rotate,
        })),
      );
      const result = await callLLM(
        {
          model,
          system: VERIFY_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user' as const,
              content: buildVisionUserContent(
                `Geometry findings from the deterministic validator (already known — confirm or extend visually): ${JSON.stringify(geometryFindings)}\nElement list (JSON): ${elementSummary}`,
                [{ id: 'slide-render', src: body.screenshot as string }],
              ),
            } as never,
          ],
          maxOutputTokens: 4096,
          maxRetries: 0,
        } as never,
        'scene-verify',
        undefined,
        thinkingConfig ?? undefined,
      );
      try {
        const text = result.text ?? '';
        const start = text.indexOf('[');
        const end = text.lastIndexOf(']');
        if (start >= 0 && end > start) {
          semanticFindings.push(...JSON.parse(text.slice(start, end + 1)));
        }
      } catch (error) {
        console.warn('[scene-verify] failed to parse LLM findings', error);
      }
    }

    return apiSuccess({ geometryFindings, semanticFindings });
  } catch (error) {
    console.error('[scene-verify]', error);
    return apiError('UPSTREAM_ERROR', 500, 'scene verification failed');
  }
}
