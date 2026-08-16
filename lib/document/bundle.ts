import { MAX_VISION_IMAGES } from '@/lib/constants/generation';
import type { PdfImage, SessionDocumentSource } from '@/lib/types/generation';

export const MAX_DOCUMENT_BUNDLE_FILES = 5;
export const MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES = 150 * 1024 * 1024;

const SECTION_SEPARATOR = '\n\n---\n\n';

export interface ParsedDocumentImage extends Omit<PdfImage, 'storageId' | 'visionPriority'> {
  src: string;
}

export interface ParsedDocumentPart {
  source: Omit<SessionDocumentSource, 'storageKey'>;
  text: string;
  rawTextLength: number;
  pageCount?: number;
  images: ParsedDocumentImage[];
}

export interface DocumentBundleResult {
  text: string;
  images: Array<ParsedDocumentImage & { visionPriority: number }>;
  /**
   * Legacy field: the pre-digest era truncated the merged text to this many
   * chars. The bundle now carries the FULL text (no cut — see
   * lib/generation/document-digest.ts); this equals totalRawTextLength and
   * exists only so old callers compile while they migrate to the handle +
   * digest flow.
   */
  textContentBudget: number;
  totalRawTextLength: number;
  totalImageCount: number;
  visionImageCount: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceImageIds(text: string, idMap: ReadonlyMap<string, string>): string {
  let nextText = text;
  for (const [fromId, toId] of idMap.entries()) {
    nextText = nextText.replace(
      new RegExp(`(?<![\\w-])${escapeRegex(fromId)}(?![\\w-])`, 'g'),
      toId,
    );
  }
  return nextText;
}

function buildSectionHeader(part: ParsedDocumentPart, index: number): string {
  const lines = [
    `## Source Document ${index + 1}: ${part.source.name}`,
    `- Order: ${part.source.order}`,
    part.source.mimeType ? `- MIME type: ${part.source.mimeType}` : undefined,
    typeof part.pageCount === 'number' ? `- Pages: ${part.pageCount}` : undefined,
    '',
  ].filter((line): line is string => typeof line === 'string');

  return `${lines.join('\n')}\n`;
}

function compareImagesForVision(a: ParsedDocumentImage, b: ParsedDocumentImage): number {
  const aHasDescription = Number(Boolean(a.description));
  const bHasDescription = Number(Boolean(b.description));
  if (aHasDescription !== bHasDescription) return bHasDescription - aHasDescription;

  const sourceDiff = (a.sourceDocumentOrder ?? 0) - (b.sourceDocumentOrder ?? 0);
  if (sourceDiff !== 0) return sourceDiff;

  const pageDiff = a.pageNumber - b.pageNumber;
  if (pageDiff !== 0) return pageDiff;

  const aArea = (a.width ?? 0) * (a.height ?? 0);
  const bArea = (b.width ?? 0) * (b.height ?? 0);
  return bArea - aArea;
}

function pickVisionImageIds(images: ParsedDocumentImage[], maxImages: number): string[] {
  if (images.length === 0 || maxImages <= 0) return [];

  const grouped = new Map<string, ParsedDocumentImage[]>();
  for (const image of images) {
    const key = image.sourceDocumentId || 'unknown';
    const bucket = grouped.get(key) ?? [];
    bucket.push(image);
    grouped.set(key, bucket);
  }

  const groups = Array.from(grouped.entries())
    .sort((a, b) => (a[1][0]?.sourceDocumentOrder ?? 0) - (b[1][0]?.sourceDocumentOrder ?? 0))
    .map(([, group]) => [...group].sort(compareImagesForVision));

  const selectedIds: string[] = [];
  for (const group of groups) {
    if (selectedIds.length >= maxImages) break;
    const image = group.shift();
    if (image) selectedIds.push(image.id);
  }

  while (selectedIds.length < maxImages) {
    let added = false;
    for (const group of groups) {
      if (selectedIds.length >= maxImages) break;
      const image = group.shift();
      if (image) {
        selectedIds.push(image.id);
        added = true;
      }
    }
    if (!added) break;
  }

  return selectedIds;
}

export function sortDocumentImagesForVision<
  T extends Pick<PdfImage, 'visionPriority' | 'pageNumber' | 'id'>,
>(images: T[]): T[] {
  return [...images].sort((a, b) => {
    const priorityDiff = (b.visionPriority ?? 0) - (a.visionPriority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
    const aNumericId = Number(a.id.match(/^img_(\d+)$/)?.[1] ?? Number.NaN);
    const bNumericId = Number(b.id.match(/^img_(\d+)$/)?.[1] ?? Number.NaN);
    if (Number.isFinite(aNumericId) && Number.isFinite(bNumericId)) {
      return aNumericId - bNumericId;
    }
    return a.id.localeCompare(b.id);
  });
}

export function buildDocumentBundle(
  parts: ParsedDocumentPart[],
  options?: { maxVisionImages?: number },
): DocumentBundleResult {
  const maxVisionImages = options?.maxVisionImages ?? MAX_VISION_IMAGES;
  const orderedParts = [...parts].sort((a, b) => a.source.order - b.source.order);

  const stableParts = orderedParts.map((part) => {
    const stableIdMap = new Map<string, string>();
    const stableImages = part.images.map((image, index) => {
      const stableId = `doc_${part.source.order}_img_${index + 1}`;
      stableIdMap.set(image.id, stableId);
      return {
        ...image,
        id: stableId,
        originalId: image.originalId ?? image.id,
        sourceDocumentId: part.source.id,
        sourceDocumentName: part.source.name,
        sourceDocumentOrder: part.source.order,
      };
    });

    return {
      ...part,
      text: replaceImageIds(part.text, stableIdMap),
      images: stableImages,
    };
  });

  const headers = stableParts.map(buildSectionHeader);

  const flattenedImages = stableParts.flatMap((part) => part.images);
  const finalIdMap = new Map<string, string>();
  flattenedImages.forEach((image, index) => finalIdMap.set(image.id, `img_${index + 1}`));

  // No truncation (Phase 2 §16): the FULL merged text rides in the bundle so
  // the server-side indexing step (sha256 → digest + chunks + captions) sees
  // the whole document. The outline prompt consumes the digest, never this.
  const text = stableParts
    .map((part, index) => `${headers[index]}${replaceImageIds(part.text, finalIdMap)}`)
    .join(SECTION_SEPARATOR);

  const totalRawTextLength = stableParts.reduce((sum, part) => sum + part.rawTextLength, 0);

  const images = flattenedImages.map((image) => ({
    ...image,
    id: finalIdMap.get(image.id) ?? image.id,
  }));

  const selectedVisionIds = pickVisionImageIds(images, maxVisionImages);
  const visionPriority = new Map(
    selectedVisionIds.map((id, index) => [id, selectedVisionIds.length - index]),
  );

  return {
    text,
    images: images.map((image) => ({
      ...image,
      visionPriority: visionPriority.get(image.id) ?? 0,
    })),
    textContentBudget: totalRawTextLength,
    totalRawTextLength,
    totalImageCount: images.length,
    visionImageCount: selectedVisionIds.length,
  };
}
