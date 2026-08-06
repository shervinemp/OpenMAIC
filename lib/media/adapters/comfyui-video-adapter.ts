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
 * Nodes patched at runtime (conventional titles, best-effort):
 *   "Input Prompt" | "String (Multiline - Prompt)" → inputs.value = prompt
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
  firstComfyMemberFile,
  loadComfyWorkflow,
  nodeInputs,
  pollComfyHistory,
  queueComfyPrompt,
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
/** Hard cap per generation: next/video API route maxDuration is 300s. */
const GENERATION_TIMEOUT_MS = 240_000;
const FETCH_TIMEOUT_MS = 30_000;
const CONNECTIVITY_TIMEOUT_MS = 10_000;
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

/**
 * Patch the workflow clone with the caller-supplied options. Best-effort:
 * unknown layouts keep the workflow's own defaults, but a missing prompt node
 * is a hard error (silent no-prompt generation is worse than a loud failure).
 */
function patchWorkflow(workflow: Record<string, unknown>, options: VideoGenerationOptions): void {
  const dims = resolveOutputDimensions(options);

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
    })}`,
  );

  const startTime = Date.now();

  // 1. Load and patch the workflow.
  const workflow = await loadComfyWorkflow({
    label: 'ComfyUI',
    workflowJson: comfyConfig.workflowJson,
    model: comfyConfig.model,
    workflowPublicPath: comfyConfig.workflowPublicPath,
  });
  patchWorkflow(workflow, options);

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
  const videoFile = firstComfyMemberFile(entry, 'videos') ?? firstComfyMemberFile(entry, 'gifs');
  if (!videoFile) {
    throw new Error(
      'ComfyUI finished but no video output was found. ' +
        'Check that your workflow includes a SaveVideo/SaveWEBM node.',
    );
  }

  const mimeType = videoFile.filename.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4';
  log.info(`Fetching video "${videoFile.filename}" from ComfyUI /view`);
  const videoBase64 = await fetchComfyFileAsBase64(baseUrl, videoFile, FETCH_TIMEOUT_MS);

  const posterFile = firstComfyMemberFile(entry, 'images');
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
