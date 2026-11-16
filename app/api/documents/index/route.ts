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
import { DOCUMENT_INDEX_OUTPUT_CAP, clampOutputBudget } from '@/lib/ai/output-budget';
import { buildVisionUserContent } from '@/lib/generation/generation-pipeline';
import {
  buildDocumentDigest,
  resolveDigestTier,
  stripExtractionNoise,
  type DocumentDigest,
} from '@/lib/generation/document-digest';
import { captionDocumentImages, type ImageCaption } from '@/lib/generation/image-captioning';
import { chunkSourceText, type PdfChunk } from '@openmaic/generation';
import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';
import { resolveModel, resolveModelFromRequest } from '@/lib/server/resolve-model';
import { getStageModel, parseUserStageRoutes } from '@/lib/server/model-routes';
import {
  buildDocumentIndexHandle,
  DOCUMENT_INDEX_KEY_VERSION,
  loadDocumentIndex,
  saveDocumentIndex,
} from '@/lib/server/document-index-store';

const log = createLogger('Documents Index API');

export const maxDuration = 900;

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

    const {
      model: languageModel,
      modelInfo,
      modelString,
      thinkingConfig,
      serverManaged,
    } = await resolveModelFromRequest(req, body, 'documents-index');
    const hasVision = !!modelInfo?.capabilities?.vision;
    // Digest cards and caption batches are small structured outputs. Bound the
    // call so an unbounded reasoning loop cannot bill a full model window.
    const indexOutputBudget = clampOutputBudget(
      DOCUMENT_INDEX_OUTPUT_CAP,
      modelInfo?.outputWindow,
      thinkingConfig,
    );

    /**
     * Captions are a perception task with short structured output: a cheap
     * vision model is usually enough, while the coverage digest stays on the
     * main model. The `documents-captions` stage route (operator MODEL_ROUTES
     * or the UI's outline station) selects that model; when it is unset, or
     * resolves without vision, the index model keeps captioning exactly as
     * before.
     */
    const captionRouteModel = getStageModel('documents-captions');
    const userRoutes = parseUserStageRoutes(req.headers.get('x-model-routes'));
    const captionRouteConfigured = Boolean(captionRouteModel || userRoutes['documents-captions']);
    const captionModel = captionRouteConfigured
      ? await resolveModel({ stage: 'documents-captions', modelString, userRoutes }).catch(
          (error: unknown) => {
            log.warn(
              `Caption model route could not be resolved; falling back to the index model:`,
              error,
            );
            return null;
          },
        )
      : null;
    const usesCaptionModel = !!captionModel?.modelInfo?.capabilities?.vision;
    if (captionModel && !usesCaptionModel) {
      log.warn(
        `Caption model "${captionModel.modelString}" has no vision capability; falling back to the index model for captions.`,
      );
    }
    const captionModelString = usesCaptionModel ? captionModel.modelString : modelString;
    const captionHasVision = usesCaptionModel ? true : hasVision;
    const captionOutputBudget = usesCaptionModel
      ? clampOutputBudget(
          DOCUMENT_INDEX_OUTPUT_CAP,
          captionModel.modelInfo?.outputWindow,
          captionModel.thinkingConfig,
        )
      : indexOutputBudget;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const enqueue = (event: Record<string, unknown>) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            // Client disconnected mid-index. Swallow the write: the indexing
            // work below keeps running and the index is still saved, so a
            // later run hits the cache instead of re-indexing from scratch.
          }
        };
        const closeStream = () => {
          try {
            controller.close();
          } catch {
            // Stream already closed by the client.
          }
        };
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(':heartbeat\n\n'));
          } catch {
            clearInterval(heartbeat);
          }
        }, 15_000);

        try {
          const handle = buildDocumentIndexHandle({
            text,
            language,
            modelString,
            captionModelString,
            images,
          });

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
            closeStream();
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
                  messages: [
                    { role: 'user' as const, content: buildVisionUserContent(user, visionImages) },
                  ],
                  maxOutputTokens: indexOutputBudget,
                  maxRetries: 1,
                },
                'documents-index',
                undefined,
                thinkingConfig,
                { serverManaged },
              );
              return result.text;
            }
            const result = await callLLM(
              {
                model: languageModel,
                system,
                prompt: user,
                maxOutputTokens: indexOutputBudget,
                maxRetries: 1,
              },
              'documents-index',
              undefined,
              thinkingConfig,
              { serverManaged },
            );
            return result.text;
          };

          /**
           * Captions ride their own model when one is routed. The batch always
           * carries image parts, so this path builds vision content directly
           * instead of reusing the generic text/vision branch above.
           */
          const captionAiCall = async (
            system: string,
            user: string,
            visionImages?: Array<{ id: string; src: string }>,
          ): Promise<string> => {
            if (!usesCaptionModel || !captionModel) return aiCall(system, user, visionImages);
            const result = await callLLM(
              {
                model: captionModel.model,
                system,
                messages: [
                  {
                    role: 'user' as const,
                    content: buildVisionUserContent(user, visionImages ?? []),
                  },
                ],
                maxOutputTokens: captionOutputBudget,
                maxRetries: 1,
              },
              'documents-captions',
              undefined,
              captionModel.thinkingConfig,
              { serverManaged: captionModel.serverManaged },
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
              onProgress: (_phase, done, total) =>
                enqueue({ type: 'progress', phase: 'digest', done, total }),
            });
            digest = result.digest;
            chunks = result.chunks;
            log.info(
              `Document digest built: ${digest.sections.length} section(s), ${result.batchCalls} LLM call(s), ${chunks.length} chunk(s), level=${digest.level}`,
            );
          }

          // 2) Batch-caption EVERY image (one-time, cached with the index).
          const captions: Record<string, ImageCaption> = {};
          let captionedCount = 0;
          if (images.length > 0 && captionHasVision) {
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
                aiCall: captionAiCall,
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
            language,
            modelString,
            captionModelString,
            keyVersion: DOCUMENT_INDEX_KEY_VERSION,
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
          closeStream();
        } catch (error) {
          clearInterval(heartbeat);
          log.error('Document indexing failed:', error);
          enqueue({
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          closeStream();
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
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
