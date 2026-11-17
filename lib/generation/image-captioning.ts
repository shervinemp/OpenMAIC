/**
 * Upload-time image captioning pass (Phase 2 §16).
 *
 * Every substantive source image gets a real content caption in ONE batched
 * vision pass at document analysis time (cached by content hash in the
 * callers). With captions, no substantive image ever travels through the
 * pipeline as metadata-only — the outline stage can reference any image by its
 * caption, and per-scene vision is reserved for the images actually relevant
 * to that scene. Icon-sized decorations are skipped: they cost vision tokens
 * and teach nothing.
 *
 * Pure functions + injected aiCall only; no I/O.
 */

import { tryParseJson } from './json-repair';
import type { AICallFn } from './pipeline-types';
import type { PdfImage } from '@/lib/types/generation';
import { imageDimensionsFromDataUrl } from '@/lib/pdf/image-header-dimensions';
import {
  CAPTION_BATCH_IMAGES,
  CAPTION_BATCH_TILES,
  CAPTION_MIN_IMAGE_PIXELS,
  CAPTION_MIN_IMAGE_SIDE,
} from '@/lib/constants/generation';

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
 * Whether an extracted image is substantive enough to deserve a vision call.
 *
 * Logos, bullets, rules and icon-sized decorations caption to "a small icon"
 * at the same price as a diagram that teaches something. Dimensions are
 * intrinsic pixels — every extractor now reports them that way, and an
 * extractor that reports page-layout coordinates must leave them undefined.
 * Unmeasurable images stay eligible: absent dimensions are not evidence of a
 * tiny image. A zero side is treated as unmeasured for the same reason — a
 * broken measurement is likelier than a zero-pixel image that decoded.
 */
export function isCaptionWorthyImage(image: Pick<PdfImage, 'width' | 'height'>): boolean {
  const { width, height } = image;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return true;
  }
  if (width === 0 || height === 0) return true;
  return (
    Math.min(width, height) >= CAPTION_MIN_IMAGE_SIDE && width * height >= CAPTION_MIN_IMAGE_PIXELS
  );
}

/**
 * Estimated vision tiles one image occupies, on a 1024-pixel grid. One tile is
 * the floor, so unknown dimensions cannot make a batch unbounded; a page-sized
 * scan of 4096×3072 costs twelve tiles and shares its call with two others.
 * Like `isCaptionWorthyImage`, this expects intrinsic pixel dimensions.
 */
export function captionImageTiles(image: Pick<PdfImage, 'width' | 'height'>): number {
  const { width, height } = image;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return 1;
  }
  return Math.max(1, Math.ceil(width / 1024) * Math.ceil(height / 1024));
}

/**
 * Split images into caption batches. Images are ordered by page (stable
 * source order) so batch boundaries follow the document flow. A batch is
 * bounded by BOTH the image count and the estimated vision-tile budget; the
 * first image of a batch is always admitted, so an image larger than the
 * whole budget still gets captioned.
 */
export function planCaptionBatches(
  images: Array<Pick<PdfImage, 'id' | 'pageNumber' | 'width' | 'height'>>,
  batchSize: number = CAPTION_BATCH_IMAGES,
  tileBudget: number = CAPTION_BATCH_TILES,
): string[][] {
  const ordered = [...images].sort((a, b) => a.pageNumber - b.pageNumber);
  const maxImages = Math.max(1, Math.floor(batchSize));
  const maxTiles = Math.max(1, Math.floor(tileBudget));
  const batches: string[][] = [];
  let current: string[] = [];
  let tiles = 0;

  for (const image of ordered) {
    const imageTiles = captionImageTiles(image);
    const overCount = current.length >= maxImages;
    const overTiles = current.length > 0 && tiles + imageTiles > maxTiles;
    if (overCount || overTiles) {
      batches.push(current);
      current = [];
      tiles = 0;
    }
    current.push(image.id);
    tiles += imageTiles;
  }
  if (current.length > 0) batches.push(current);
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
  // Re-read the dimensions the image itself declares when its bytes are
  // available. This corrects callers holding a layout box (a legacy MinerU
  // parse, a session saved before dimensions were normalized) and keeps the
  // filter and tile estimate on one unit: intrinsic pixels.
  const measuredImages = images.map((image) => {
    const measured = imageDimensionsFromDataUrl(image.src);
    return measured ? { ...image, width: measured.width, height: measured.height } : image;
  });
  // Tiny decorations are not course material. Skipping them saves their vision
  // tokens and, when a document is mostly icons, saves the call entirely.
  const eligible = measuredImages.filter(isCaptionWorthyImage);
  const batches = planCaptionBatches(eligible, options.batchSize ?? CAPTION_BATCH_IMAGES);
  const byId = new Map(eligible.map((image) => [image.id, image]));
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
