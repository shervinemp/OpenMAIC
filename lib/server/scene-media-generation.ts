/**
 * Resolve a generated scene's `gen_img_*` / `gen_vid_*` placeholders on the
 * server. The browser used to be the only caller of the media APIs, so backend
 * continuation jobs committed slides with unresolved placeholders and no
 * graphics. This is the same sequence the browser orchestrator performs:
 * render the media, allocate it in the asset pool, then write the allocated id
 * back into the scene before it is committed.
 */
import { Agent, fetch as undiciFetch } from 'undici';

import { storeGeneratedAssetOrThrow } from '@/lib/server/store-generated-asset';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const REQUEST_TIMEOUT = 90 * 60_000;

/**
 * Media generation routinely takes five to ten minutes. Node's global fetch
 * uses undici's default 300 s `headersTimeout`, so a video that finishes in
 * ~306 s is abandoned by the client even though the provider returned 200 -
 * the caller only sees `fetch failed`. Give both the header and body phases
 * the full request budget, as the LLM transport does for long thinking calls.
 */
const mediaRequestAgent = new Agent({
  headersTimeout: REQUEST_TIMEOUT,
  bodyTimeout: REQUEST_TIMEOUT,
  connectTimeout: 30_000,
});

export function replaceMediaRefs(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((item) => replaceMediaRefs(item, from, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceMediaRefs(item, from, to)]),
    );
  }
  return value;
}

async function postJson(path: string, body: Record<string, unknown>) {
  const response = await undiciFetch(`http://127.0.0.1:${process.env.PORT ?? 3000}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    dispatcher: mediaRequestAgent,
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    // fall through to the status error below
  }
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${text.slice(0, 300)}`);
  return payload;
}

export async function mediaBytes(result: Record<string, unknown>, fallbackMime: string) {
  const inline = result.base64;
  if (typeof inline === 'string') {
    return {
      bytes: Buffer.from(inline, 'base64'),
      mimeType: typeof result.mimeType === 'string' ? result.mimeType : fallbackMime,
    };
  }
  const url = result.ossUrl || result.url;
  if (typeof url !== 'string' || !url) throw new Error('media provider returned no bytes or URL');

  // Providers return inline data URIs. Decode them here instead of putting
  // them through fetch(): a data URL whose base64 carries line breaks (as
  // ComfyUI's can) makes undici reject it with "failed to fetch the data URL".
  const inlineUri = /^data:([^,]*),([\s\S]*)$/.exec(url);
  if (inlineUri) {
    const header = inlineUri[1] ?? '';
    const mediaType = header.split(';', 1)[0] || fallbackMime;
    const payload = inlineUri[2] ?? '';
    const bytes = /;base64/i.test(header)
      ? Buffer.from(payload.replace(/\s/g, ''), 'base64')
      : Buffer.from(decodeURIComponent(payload));
    return {
      bytes,
      mimeType: (typeof result.mimeType === 'string' ? result.mimeType : null) || mediaType,
    };
  }

  const response = await undiciFetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    dispatcher: mediaRequestAgent,
  });
  if (!response.ok) throw new Error(`media download failed: ${response.status}`);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mimeType:
      (typeof result.mimeType === 'string' ? result.mimeType : null) ||
      response.headers.get('content-type') ||
      fallbackMime,
  };
}

export interface SceneMediaSummary {
  scene: Scene;
  generated: string[];
  failed: string[];
}

/**
 * Fail-open per request: an unreachable image/video provider must not discard
 * an otherwise valid scene. Unresolved placeholders are visible in the document
 * and can be retried by a later pass.
 */
export async function resolveSceneMedia({
  scene,
  outline,
  stageId,
  ownerId,
}: {
  scene: Scene;
  outline: SceneOutline;
  stageId: string;
  ownerId: string;
}): Promise<SceneMediaSummary> {
  const requests = (outline.mediaGenerations ?? []).filter(
    (request) => request.type === 'image' || request.type === 'video',
  );
  if (!requests.length) return { scene, generated: [], failed: [] };

  let next = scene;
  const serialized = JSON.stringify(scene);
  const generated: string[] = [];
  const failed: string[] = [];
  for (const request of requests) {
    if (!serialized.includes(request.elementId)) continue;
    try {
      const endpoint = request.type === 'image' ? '/api/generate/image' : '/api/generate/video';
      const body: Record<string, unknown> = {
        prompt: request.prompt,
        aspectRatio: request.aspectRatio ?? '16:9',
      };
      if (request.type === 'image') {
        body.width = 1280;
        body.height = 720;
      }
      const response = await postJson(endpoint, body);
      const result = response.result;
      if (!result || typeof result !== 'object') throw new Error(`${endpoint} returned no result`);
      const { bytes, mimeType } = await mediaBytes(
        result as Record<string, unknown>,
        request.type === 'image' ? 'image/png' : 'video/mp4',
      );
      const assetId = await storeGeneratedAssetOrThrow({
        ownerId,
        stageId,
        bytes: new Uint8Array(bytes),
        mimeType,
        kind: request.type === 'image' ? 'image' : 'video',
      });
      next = replaceMediaRefs(next, request.elementId, assetId) as Scene;
      generated.push(request.elementId);
    } catch (error) {
      failed.push(request.elementId);
      console.error(
        `[SceneMedia] ${request.elementId} (${request.type}) failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { scene: next, generated, failed };
}
