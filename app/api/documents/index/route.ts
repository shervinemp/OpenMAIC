/**
 * Document indexing API (SSE) — Phase 2 §16.
 *
 * One endpoint that turns extracted source material into a reusable index:
 * full text stored server-side by content hash, retrieval chunks, a coverage
 * digest for the outline stage, and batched vision captions for EVERY image.
 * Everything is cached by the text's sha256 — re-running any course over the
 * same document reuses the index with zero LLM calls.
 *
 * SSE events:
 *   { type: 'progress', phase: 'digest' | 'captions', done, total }
 *   { type: 'done', data: { handle, tier, digest, captions, chunkCount,
 *       totalImageCount, captionedCount, cached } }
 *   { type: 'error', error: string }
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { buildVisionUserContent } from '@/lib/generation/generation-pipeline';
import {
  buildDocumentDigest,
  resolveDigestTier,
  stripExtractionNoise,
  type DocumentDigest,
} from '@/lib/generation/document-digest';
import {
  captionDocumentImages,
  type ImageCaption,
} from '@/lib/generation/image-captioning';
import { chunkSourceText, type PdfChunk } from '@/lib/generation/pdf-retrieval';
import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import {
  loadDocumentIndex,
  saveDocumentIndex,
  sha256Text,
} from '@/lib/server/document-index-store';

const log = createLogger('Documents Index API');

export const maxDuration = 300;

interface IndexImageInput {
  id: string;
  src?: string;
  pageNumber?: number;
  width?: number;
  height?: number;
  description?: string;
}

interface IndexRequestBody {
  text: string;
  images?: IndexImageInput[];
  language?: string;
}

const MAX_INDEX_TEXT_CHARS = 5_000_000;
const MAX_INDEX_IMAGES = 500;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<IndexRequestBody>;

    if (typeof body.text !== 'string' || !body.text.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'text is required');
    }
    if (body.text.length > MAX_INDEX_TEXT_CHARS) {
      return apiError('INVALID_REQUEST', 413, 'Document text is too large to index');
    }
    const images = Array.isArray(body.images) ? body.images.slice(0, MAX_INDEX_IMAGES) : [];
    const language = typeof body.language === 'string' && body.language ? body.language : 'English';
    const text = body.text;

    const { model: languageModel, modelInfo, thinkingConfig } =
      await resolveModelFromRequest(req, body, 'documents-index');
    const hasVision = !!modelInfo?.capabilities?.vision;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const enqueue = (event: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(':heartbeat\n\n'));
          } catch {
            clearInterval(heartbeat);
          }
        }, 15_000);

        try {
          const handle = sha256Text(text);

          // Cached index: reply straight from the store, zero LLM calls.
          const existing = await loadDocumentIndex(handle);
          if (existing) {
            enqueue({
              type: 'done',
              data: {
                handle,
                tier: existing.tier,
                digest: existing.digest,
                captions: existing.captions,
                chunkCount: existing.chunks.length,
                totalImageCount: existing.totalImageCount,
                captionedCount: existing.captionedCount,
                cached: true,
              },
            });
            clearInterval(heartbeat);
            controller.close();
            return;
          }

          const aiCall = async (
            system: string,
            user: string,
            visionImages?: Array<{ id: string; src: string }>,
          ): Promise<string> => {
            if (visionImages?.length && hasVision) {
              const result = await callLLM(
                {
                  model: languageModel,
                  system,
                  messages: [{ role: 'user' as const, content: buildVisionUserContent(user, visionImages) }],
                  maxOutputTokens: modelInfo?.outputWindow,
                  maxRetries: 1,
                  abortSignal: req.signal,
                },
                'documents-index',
                undefined,
                thinkingConfig,
              );
              return result.text;
            }
            const result = await callLLM(
              {
                model: languageModel,
                system,
                prompt: user,
                maxOutputTokens: modelInfo?.outputWindow,
                maxRetries: 1,
                abortSignal: req.signal,
              },
              'documents-index',
              undefined,
              thinkingConfig,
            );
            return result.text;
          };

          // 1) Coverage digest (skipped for small documents — raw tier).
          const tier = resolveDigestTier(text.length);
          let digest: DocumentDigest;
          let chunks: PdfChunk[];
          if (tier === 'raw') {
            // Raw tier still strips extraction noise before chunking so page
            // headers/footers don't pollute the retrieval chunks and citations.
            chunks = chunkSourceText(stripExtractionNoise(text));
            digest = { level: 'single', sections: [], totalChars: text.length };
          } else {
            const result = await buildDocumentDigest(text, {
              language,
              aiCall,
              onProgress: (done, total) =>
                enqueue({ type: 'progress', phase: 'digest', done, total }),
            });
            digest = result.digest;
            chunks = result.chunks;
          }

          // 2) Batch-caption EVERY image (one-time, cached with the index).
          const captions: Record<string, ImageCaption> = {};
          let captionedCount = 0;
          if (images.length > 0 && hasVision) {
            const pass = await captionDocumentImages(
              images.map((image) => ({
                id: image.id,
                src: image.src ?? '',
                pageNumber: image.pageNumber ?? 1,
                width: image.width,
                height: image.height,
              })),
              {
                language,
                aiCall,
                onProgress: (done, total) =>
                  enqueue({ type: 'progress', phase: 'captions', done, total }),
              },
            );
            for (const [id, caption] of pass.entries()) {
              captions[id] = caption;
            }
            captionedCount = pass.size;
          } else if (images.length > 0) {
            // No vision model: fall back to the extractor's metadata
            // descriptions so images are never fully metadata-only. (unpdf
            // extracts no descriptions, so this only enriches images when the
            // extractor provides them.)
            for (const image of images) {
              const description = image.description?.trim();
              if (description) {
                captions[image.id] = { id: image.id, caption: description, kind: 'other' };
                captionedCount += 1;
              }
            }
          }

          await saveDocumentIndex({
            version: 1,
            handle,
            text,
            chunks,
            digest,
            captions,
            tier,
            totalImageCount: images.length,
            captionedCount,
            createdAt: new Date().toISOString(),
          });

          enqueue({
            type: 'done',
            data: {
              handle,
              tier,
              digest,
              captions,
              chunkCount: chunks.length,
              totalImageCount: images.length,
              captionedCount,
              cached: false,
            },
          });
          clearInterval(heartbeat);
          controller.close();
        } catch (error) {
          clearInterval(heartbeat);
          log.error('Document indexing failed:', error);
          enqueue({
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    log.error('Document index request failed:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : 'Unknown error');
  }
}
