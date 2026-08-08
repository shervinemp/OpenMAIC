/**
 * ComfyUI Video Generation Adapter
 *
 * Submits a prompt to a local (or remote) ComfyUI instance via its REST API,
 * polls for completion, and returns the video as a base64 data URL (the same
 * shape the Veo adapter returns, which `media-orchestrator.fetchAsBlob` can
 * consume directly).
 *
 * Endpoint: http://localhost:8188  (configurable via baseUrl) — no API key.
 *
 * Workflow selection, /prompt + /history polling, error extraction, and the
 * public/ traversal hardening live in `comfyui-shared` (shared with the image
 * adapter). This module only adds the video-specific parts: output picking
 * (`videos`/`gifs`), poster extraction, and runtime option patching.
 *
 * Text-to-video and image-to-video share this adapter. When `options.inputImage`
 * is supplied and the workflow contains a Load Image node, the image is
 * uploaded (POST /upload/image) and its name is injected into the node before
 * the prompt is queued — so a single Wan/CogVideoX I2V workflow in public/ is
 * enough to animate an existing image.
 *
 * Nodes patched at runtime (conventional titles, best-effort):
 *   "Input Prompt" | "String (Multiline - Prompt)" → inputs.value = prompt
 *   "Load Image" (or class LoadImage)              → inputs.image = uploaded name
 *   "Width"/"Height"                               → inputs.value = dims
 *   "Duration"                                     → inputs.value = seconds
 *   "KSampler"                                     → inputs.seed  = random int
 */
import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';
import { aspectRatioToDimensions } from '../image-providers';
import {
  DEFAULT_COMFYUI_BASE_URL,
  extractComfyExecutionError,
  fetchComfyFileAsBase64,
  findNodeIdByTitle,
  firstComfyImageFile,
  firstComfyVideoFile,
  loadComfyWorkflow,
  nodeInputs,
  pollComfyHistory,
  queueComfyPrompt,
  uploadComfyImage,
  type ComfyUploadResult,
} from './comfyui-shared';

const COMPONENT = 'ComfyUI Video';

const log = {
  info: (msg: string) => console.log(`[${new Date().toISOString()}] [INFO]  [${COMPONENT}] ${msg}`),
  warn: (msg: string) =>
    console.warn(`[${new Date().toISOString()}] [WARN]  [${COMPONENT}] ${msg}`),
  error: (msg: string) =>
    console.error(`[${new Date().toISOString()}] [ERROR] [${COMPONENT}] ${msg}`),
  debug: (msg: string) =>
    console.debug(`[${new Date().toISOString()}] [DEBUG] [${COMPONENT}] ${msg}`),
};

const POLL_INTERVAL_MS = 2000;
/** Hard cap per generation: next/video API route maxDuration is 900s.
 *  Local MiniMax H3 15s clips take ~10-12 min, well under the 15 min cap. */
const GENERATION_TIMEOUT_MS = 900_000;
const FETCH_TIMEOUT_MS = 30_000;
const CONNECTIVITY_TIMEOUT_MS = 10_000;
/** Ceiling on the decoded size of a client-supplied input image (memory guard). */
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
/** Base width per resolution tier (height follows aspect ratio, default 16:9). */
const RESOLUTION_WIDTHS: Record<string, number> = { '480p': 854, '720p': 1280, '1080p': 1920 };
const DEFAULT_WIDTH = 1280;

interface ComfyUIVideoGenerationConfig extends VideoGenerationConfig, ComfyVideoWorkflow {
  workflowPublicPath?: string;
}

/** Extra workflow-input surface the caller may supply (workflowJson/model). */
type ComfyVideoWorkflow = {
  workflowJson?: Record<string, unknown>;
};

function resolveOutputDimensions(options: VideoGenerationOptions): {
  width: number;
  height: number;
} {
  const base = RESOLUTION_WIDTHS[options.resolution ?? ''] ?? DEFAULT_WIDTH;
  if (options.aspectRatio) {
    const dims = aspectRatioToDimensions(options.aspectRatio, base);
    return { width: dims.width, height: dims.height };
  }
  return { width: base, height: Math.round((base * 9) / 16) };
}

/** First node that loads a source image — by title, then by class_type. */
function findLoadImageNode(workflow: Record<string, unknown>): string | undefined {
  const byTitle = findNodeIdByTitle(workflow, 'Load Image');
  if (byTitle) return byTitle;
  for (const [id, node] of Object.entries(workflow)) {
    if ((node as Record<string, unknown>)['class_type'] === 'LoadImage') return id;
  }
  return undefined;
}

function filenameForMime(mime: string): string {
  const ext =
    { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime] ??
    'png';
  return `input.${ext}`;
}

function filenameFromUrl(url: string): string {
  try {
    const segment = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    if (/\.(png|jpe?g|webp|gif)$/i.test(segment)) return segment;
  } catch {
    // fall through to the generic name
  }
  return 'input.png';
}

/**
 * Turn a client-supplied input image into upload-ready bytes + a filename.
 * Accepts base64 data URLs and http(s) URLs. Remote URLs are SSRF-checked at
 * the API route in production (this module stays server-only-import-free so
 * the client bundle can include it).
 */
async function resolveInputImageBytes(
  inputImage: string,
): Promise<{ bytes: Uint8Array; filename: string }> {
  if (inputImage.startsWith('data:')) {
    const comma = inputImage.indexOf(',');
    if (comma < 0) {
      throw new Error('ComfyUI: malformed input image data URL.');
    }
    const meta = inputImage.slice(5, comma);
    if (!meta.includes(';base64')) {
      throw new Error(
        'ComfyUI: input image data URL must be base64-encoded (data:<mime>;base64,...).',
      );
    }
    const raw = inputImage.slice(comma + 1);
    const bytes =
      typeof Buffer !== 'undefined'
        ? new Uint8Array(Buffer.from(raw, 'base64'))
        : Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    if (bytes.byteLength > MAX_INPUT_IMAGE_BYTES) {
      throw new Error(
        `ComfyUI: input image exceeds the ${MAX_INPUT_IMAGE_BYTES / (1024 * 1024)}MB size limit.`,
      );
    }
    const mime = meta.split(';')[0] || 'image/png';
    return { bytes, filename: filenameForMime(mime) };
  }

  if (/^https?:\/\//i.test(inputImage)) {
    // SSRF validation for client-supplied remote URLs happens at the API
    // route (app/api/generate/video/route.ts) in production — this module is
    // reachable from the client bundle, so it must not import server-only
    // modules (e.g. node:dns via ssrf-guard).
    const response = await fetch(inputImage, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`ComfyUI: failed to fetch input image (HTTP ${response.status}).`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_INPUT_IMAGE_BYTES) {
      throw new Error(
        `ComfyUI: input image exceeds the ${MAX_INPUT_IMAGE_BYTES / (1024 * 1024)}MB size limit.`,
      );
    }
    return { bytes, filename: filenameFromUrl(inputImage) };
  }

  throw new Error('ComfyUI: input image must be a base64 data URL or an http(s) URL.');
}

/**
 * Patch the workflow clone with the caller-supplied options. Best-effort:
 * unknown layouts keep the workflow's own defaults, but a missing prompt node
 * is a hard error (silent no-prompt generation is worse than a loud failure).
 */
function patchWorkflow(
  workflow: Record<string, unknown>,
  options: VideoGenerationOptions,
  uploadedImage?: ComfyUploadResult,
): void {
  const dims = resolveOutputDimensions(options);

  // --- Load Image (image-to-video) ------------------------------------------
  const loadImageNodeId = findLoadImageNode(workflow);
  if (loadImageNodeId) {
    const imageInputs = nodeInputs(workflow[loadImageNodeId]);
    if (!imageInputs) {
      log.warn(
        `Load Image node (id: ${loadImageNodeId}) is malformed (missing "inputs") — skipping image injection`,
      );
    } else if (!uploadedImage) {
      throw new Error(
        'ComfyUI video workflow uses a Load Image node (image-to-video) but no input image ' +
          'was provided. Pass an inputImage (base64 data URL or http(s) URL) to animate a ' +
          'source image, or pick a text-to-video workflow instead.',
      );
    } else {
      imageInputs['image'] = uploadedImage.name;
      log.debug(`Patched Load Image node (id: ${loadImageNodeId}) → "${uploadedImage.name}"`);
    }
  } else if (uploadedImage) {
    log.warn(
      'Workflow has no Load Image node — ignoring supplied input image (text-to-video workflow).',
    );
  }

  const promptNodeId =
    findNodeIdByTitle(workflow, 'Input Prompt') ??
    findNodeIdByTitle(workflow, 'String (Multiline - Prompt)');
  if (promptNodeId) {
    const inputs = nodeInputs(workflow[promptNodeId]);
    if (inputs) {
      inputs['value'] = options.prompt;
    }
  } else {
    throw new Error(
      'ComfyUI video workflow is missing a prompt input node. ' +
        'Add a node titled "Input Prompt" (or "String (Multiline - Prompt)").',
    );
  }

  const widthNodeId = findNodeIdByTitle(workflow, 'Width');
  const heightNodeId = findNodeIdByTitle(workflow, 'Height');
  if (widthNodeId && heightNodeId) {
    const widthInputs = nodeInputs(workflow[widthNodeId]);
    const heightInputs = nodeInputs(workflow[heightNodeId]);
    if (widthInputs && heightInputs) {
      widthInputs['value'] = dims.width;
      heightInputs['value'] = dims.height;
      log.debug(`Patched Width/Height → ${dims.width}x${dims.height}`);
    }
  }

  if (options.duration) {
    const durationNodeId = findNodeIdByTitle(workflow, 'Duration');
    if (durationNodeId) {
      const durationInputs = nodeInputs(workflow[durationNodeId]);
      if (durationInputs) {
        durationInputs['value'] = options.duration;
        log.debug(`Patched Duration → ${options.duration}s`);
      }
    }
  }

  for (const title of ['KSampler', 'KSampler Adv', 'KSamplerAdvanced']) {
    const samplerNodeId = findNodeIdByTitle(workflow, title);
    if (samplerNodeId) {
      const samplerInputs = nodeInputs(workflow[samplerNodeId]);
      if (samplerInputs) {
        samplerInputs['seed'] = Math.floor(Math.random() * 1e15);
      }
      break;
    }
  }
}

export async function testComfyuiVideoConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = (config.baseUrl || DEFAULT_COMFYUI_BASE_URL).replace(/\/$/, '');
  try {
    const response = await fetch(`${baseUrl}/system_stats`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(CONNECTIVITY_TIMEOUT_MS),
    });
    if (response.ok) {
      return { success: true, message: 'Connected to ComfyUI' };
    }
    return {
      success: false,
      message: `ComfyUI returned HTTP ${response.status}. Is it running at ${baseUrl}?`,
    };
  } catch (err) {
    return {
      success: false,
      message: `ComfyUI connectivity error: ${err}. Is it running at ${baseUrl}?`,
    };
  }
}

export async function generateWithComfyuiVideo(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  const baseUrl = (config.baseUrl || DEFAULT_COMFYUI_BASE_URL).replace(/\/$/, '');
  const comfyConfig = config as ComfyUIVideoGenerationConfig;

  log.info(
    `Starting video generation [baseUrl: ${baseUrl}] [workflow: ${config.model ?? 'default'}]`,
  );
  log.debug(
    `Options: ${JSON.stringify({
      duration: options.duration,
      aspectRatio: options.aspectRatio,
      resolution: options.resolution,
      inputImage: options.inputImage ? 'present' : 'none',
    })}`,
  );

  const startTime = Date.now();

  // 1. Load the workflow, then upload any input image for image-to-video.
  const workflow = await loadComfyWorkflow({
    label: 'ComfyUI',
    workflowJson: comfyConfig.workflowJson,
    model: comfyConfig.model,
    workflowPublicPath: comfyConfig.workflowPublicPath,
  });

  const loadImageNodeId = findLoadImageNode(workflow);
  let uploadedImage: ComfyUploadResult | undefined;
  if (loadImageNodeId) {
    if (!options.inputImage) {
      throw new Error(
        'ComfyUI video workflow uses a Load Image node (image-to-video) but no input image ' +
          'was provided. Pass an inputImage (base64 data URL or http(s) URL) to animate a ' +
          'source image, or pick a text-to-video workflow instead.',
      );
    }
    const { bytes, filename } = await resolveInputImageBytes(options.inputImage);
    uploadedImage = await uploadComfyImage(baseUrl, bytes, filename, FETCH_TIMEOUT_MS);
    log.info(`Uploaded input image "${filename}" → "${uploadedImage.name}"`);
  } else if (options.inputImage) {
    log.warn(
      'Workflow has no Load Image node — ignoring supplied input image (text-to-video workflow).',
    );
  }

  patchWorkflow(workflow, options, uploadedImage);

  // 2. Submit to the queue.
  const clientId = `openmaic-video-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const promptId = await queueComfyPrompt(baseUrl, workflow, clientId, FETCH_TIMEOUT_MS);

  // 3. Poll until complete (or the request deadline is hit).
  const deadline = Date.now() + GENERATION_TIMEOUT_MS;
  let entry: Awaited<ReturnType<typeof pollComfyHistory>> = null;
  let pollCount = 0;

  log.info(`Polling for completion [prompt_id: ${promptId}]`);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    pollCount += 1;
    entry = await pollComfyHistory(baseUrl, promptId, FETCH_TIMEOUT_MS);

    if (entry?.status?.status_str === 'error') {
      const detail = extractComfyExecutionError(entry);
      throw new Error(
        `ComfyUI video workflow execution failed (prompt_id: ${promptId})` +
          (detail ? `: ${detail}` : '. Check the ComfyUI server logs for details.'),
      );
    }
    if (entry?.status?.completed) {
      log.info(
        `Generation complete after ${pollCount} poll(s) (${((Date.now() - startTime) / 1000).toFixed(1)}s)`,
      );
      break;
    }
    if (pollCount % 10 === 0) {
      log.debug(
        `Still waiting… ${pollCount} polls, ${((Date.now() - startTime) / 1000).toFixed(0)}s elapsed`,
      );
    }
  }

  if (!entry?.status?.completed) {
    throw new Error(
      `ComfyUI video generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s (prompt_id: ${promptId}). ` +
        'Your GPU may be too slow for this resolution/duration, or the workflow used a ' +
        'pipeline longer than the API timeout.',
    );
  }

  // 4. Extract the first video output (+ optional first-frame poster).
  const videoFile = firstComfyVideoFile(entry);
  if (!videoFile) {
    throw new Error(
      'ComfyUI finished but no video output was found. ' +
        'Check that your workflow includes a SaveVideo/SaveWEBM node.',
    );
  }

  const filename = videoFile.filename.toLowerCase();
  const mimeType = filename.endsWith('.webm')
    ? 'video/webm'
    : filename.endsWith('.mov')
      ? 'video/quicktime'
      : filename.endsWith('.gif')
        ? 'image/gif'
        : 'video/mp4';
  log.info(`Fetching video "${videoFile.filename}" from ComfyUI /view`);
  const videoBase64 = await fetchComfyFileAsBase64(baseUrl, videoFile, FETCH_TIMEOUT_MS);

  const posterFile = firstComfyImageFile(entry);
  let poster: string | undefined;
  if (posterFile) {
    try {
      poster = `data:image/jpeg;base64,${await fetchComfyFileAsBase64(baseUrl, posterFile, FETCH_TIMEOUT_MS)}`;
    } catch {
      log.warn('Could not fetch ComfyUI poster frame; continuing without one.');
    }
  }

  const dims = resolveOutputDimensions(options);
  log.info(
    `Video complete — ${videoFile.filename} (${dims.width}x${dims.height}) in ${((Date.now() - startTime) / 1000).toFixed(1)}s`,
  );

  return {
    url: `data:${mimeType};base64,${videoBase64}`,
    poster,
    width: dims.width,
    height: dims.height,
    duration: options.duration ?? 5,
  };
}
