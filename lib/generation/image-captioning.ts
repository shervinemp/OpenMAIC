/**
 * Upload-time image captioning pass (Phase 2 §16).
 *
 * Every source image gets a real content caption in ONE batched vision pass
 * at document analysis time (cached by content hash in the callers). With
 * captions, no image ever travels through the pipeline as metadata-only —
 * the outline stage can reference any image by its caption, and per-scene
 * vision is reserved for the images actually relevant to that scene.
 *
 * Pure functions + injected aiCall only; no I/O.
 */

import { tryParseJson } from './json-repair';
import type { AICallFn } from './pipeline-types';
import type { PdfImage } from '@/lib/types/generation';
import { CAPTION_BATCH_IMAGES } from '@/lib/constants/generation';

// ==================== Types ====================

export type CaptionedImageKind =
  | 'diagram'
  | 'photo'
  | 'screenshot'
  | 'logo'
  | 'chart'
  | 'table'
  | 'illustration'
  | 'other';

export interface ImageCaption {
  /** Image id the caption belongs to. */
  id: string;
  /** Content description — what the image shows and teaches, 1-2 sentences. */
  caption: string;
  /** Content kind, used for relevance scoring and prompt framing. */
  kind: CaptionedImageKind;
}

// ==================== Batch planning ====================

/**
 * Split images into caption batches. Images are ordered by page (stable
 * source order) so batch boundaries follow the document flow.
 */
export function planCaptionBatches(
  images: Array<Pick<PdfImage, 'id' | 'pageNumber'>>,
  batchSize: number = CAPTION_BATCH_IMAGES,
): string[][] {
  const ordered = [...images].sort((a, b) => a.pageNumber - b.pageNumber);
  const batches: string[][] = [];
  for (let i = 0; i < ordered.length; i += batchSize) {
    batches.push(ordered.slice(i, i + batchSize).map((image) => image.id));
  }
  return batches;
}

// ==================== Prompt ====================

/**
 * Caption prompt for one batch. The caller passes the actual image parts
 * (buildVisionUserContent) so ids in the text line up with vision content.
 */
export function buildCaptionPrompt(
  images: Array<Pick<PdfImage, 'id' | 'pageNumber'>>,
  language: string = 'English',
): { system: string; user: string } {
  const labels = images
    .map((image) => `- ${image.id} (document page ${image.pageNumber})`)
    .join('\n');
  return {
    system: [
      'You are captioning images extracted from a source document for a course generation pipeline.',
      'For EVERY attached image, describe what it shows and what it teaches in 1-2 sentences.',
      'Classify each image as one of: diagram, photo, screenshot, logo, chart, table, illustration, other.',
      `Respond in ${language}.`,
      'Respond ONLY with JSON: {"images": [{"id": "img_1", "caption": "...", "kind": "diagram"}]}',
    ].join('\n'),
    user: `## Images in this batch\n${labels}\n\nEach image follows its id label. Caption all of them.`,
  };
}

// ==================== Parsing ====================

const CAPTION_KINDS: ReadonlySet<string> = new Set<CaptionedImageKind>([
  'diagram',
  'photo',
  'screenshot',
  'logo',
  'chart',
  'table',
  'illustration',
  'other',
]);

/**
 * Parse a caption batch response into id → caption entries. Entries whose
 * id is not in the batch or whose caption is empty are dropped; valid
 * entries with unknown kinds normalize to "other".
 */
export function parseCaptionResponse(text: string, batchIds: string[]): ImageCaption[] {
  const parsed = tryParseJson<{ images?: unknown }>(text);
  if (!parsed || !Array.isArray(parsed.images)) return [];
  const idSet = new Set(batchIds);
  const captions: ImageCaption[] = [];
  for (const entry of parsed.images) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, caption, kind } = entry as { id?: unknown; caption?: unknown; kind?: unknown };
    if (typeof id !== 'string' || !idSet.has(id)) continue;
    if (typeof caption !== 'string' || !caption.trim()) continue;
    captions.push({
      id,
      caption: caption.trim(),
      kind:
        typeof kind === 'string' && CAPTION_KINDS.has(kind)
          ? (kind as CaptionedImageKind)
          : 'other',
    });
  }
  return captions;
}

// ==================== Orchestrator ====================

export interface CaptionPassOptions {
  language?: string;
  batchSize?: number;
  /** Called with (system, user, images) per batch — vision-aware caller. */
  aiCall: AICallFn;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Caption ALL images of the source document in batched vision calls.
 * Returns the captions indexed by id; images a batch failed to parse are
 * simply absent (callers keep their existing metadata description).
 */
export async function captionDocumentImages(
  images: PdfImage[],
  options: CaptionPassOptions,
): Promise<Map<string, ImageCaption>> {
  const batches = planCaptionBatches(images, options.batchSize ?? CAPTION_BATCH_IMAGES);
  const byId = new Map(images.map((image) => [image.id, image]));
  const result = new Map<string, ImageCaption>();
  const language = options.language ?? 'English';

  let done = 0;
  for (const batchIds of batches) {
    const batchImages = batchIds
      .map((id) => byId.get(id))
      .filter((image): image is PdfImage => !!image);
    const prompt = buildCaptionPrompt(batchImages, language);
    const visionParts = batchImages.map((image) => ({
      id: image.id,
      src: image.src,
      width: image.width,
      height: image.height,
    }));
    const response = await options.aiCall(prompt.system, prompt.user, visionParts);
    for (const caption of parseCaptionResponse(response, batchIds)) {
      result.set(caption.id, caption);
    }
    done += 1;
    options.onProgress?.(done, batches.length);
  }
  return result;
}
