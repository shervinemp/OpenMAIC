/**
 * ComfyUI Video Generation Adapter
 *
 * Submits a prompt to a local (or remote) ComfyUI instance via its REST API,
 * polls for completion, and returns the video as a base64 data URL (the same
 * shape the Veo adapter returns, which `media-orchestrator.fetchAsBlob` can
 * consume directly).
 *
 * Endpoint: http://localhost:8188  (configurable via baseUrl)
 * No API key required.
 *
 * Workflow selection mirrors comfyui-image-adapter: a workflow may be supplied
 * as parsed JSON, named by file (validated against the public/ allowlist), or
 * defaulted to the first `comfyui-*.json` discovered in public/.
 *
 * Nodes patched at runtime (matching the image adapter's conventions):
 *   "Input Prompt" | "String (Multiline - Prompt)" → inputs.value = prompt
 *   "Width"/"Height"                               → inputs.value = dims
 *   "Duration"                                     → inputs.value = seconds
 *   "KSampler"                                     → inputs.seed  = random int
 *
 * Output: the first `videos`/`gifs` output produced by a SaveVideo-style node,
 * with an optional poster (first `images` output, e.g. a preview frame).
 */
import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';
import { aspectRatioToDimensions } from '../image-providers';

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

const DEFAULT_BASE_URL = 'http://localhost:8188';
/** Polling interval while waiting for the queue to finish (ms) */
const POLL_INTERVAL_MS = 2000;
/** Hard timeout for a single generation request (ms). Next.js route maxDuration is 300s. */
const GENERATION_TIMEOUT_MS = 240_000;
/** Per-request timeout for individual ComfyUI HTTP calls (ms) */
const FETCH_TIMEOUT_MS = 30_000;
/** Timeout for the lightweight connectivity probe (ms) */
const CONNECTIVITY_TIMEOUT_MS = 10_000;
/** Base width per resolution tier (height follows aspect ratio, default 16:9). */
const RESOLUTION_WIDTHS: Record<string, number> = { '480p': 854, '720p': 1280, '1080p': 1920 };
const DEFAULT_WIDTH = 1280;

interface ComfyUIVideoGenerationConfig extends VideoGenerationConfig {
  /** Pre-parsed workflow object (deep-cloned on each request). */
  workflowJson?: Record<string, unknown>;
  /** Public URL path to fetch the workflow JSON from (default "/<model>"). */
  workflowPublicPath?: string;
}

// ---------------------------------------------------------------------------
// Workflow loading (same hardening contract as comfyui-image-adapter)
// ---------------------------------------------------------------------------

async function loadWorkflow(
  config: ComfyUIVideoGenerationConfig,
): Promise<Record<string, unknown>> {
  if (config.workflowJson) {
    return JSON.parse(JSON.stringify(config.workflowJson)) as Record<string, unknown>;
  }

  if (typeof window === 'undefined') {
    const fs = await import('fs');
    const path = await import('path');
    const { isComfyuiWorkflowFilename, listComfyuiWorkflowFilenames } =
      await import('../comfyui-workflows');

    let filename: string;
    if (config.workflowPublicPath) {
      filename = path.basename(config.workflowPublicPath);
    } else if (config.model) {
      // Client-controlled: must be a safe basename AND a real discovered file.
      if (!isComfyuiWorkflowFilename(config.model)) {
        log.error(`Rejected unsafe workflow identifier: "${config.model}"`);
        throw new Error(`ComfyUI video: "${config.model}" is not a valid workflow filename.`);
      }
      const known = await listComfyuiWorkflowFilenames();
      if (!known.includes(config.model)) {
        log.error(`Rejected unknown workflow identifier: "${config.model}"`);
        throw new Error(
          `ComfyUI video: workflow "${config.model}" was not found. ` +
            'Choose one returned by /api/comfyui-workflows.',
        );
      }
      filename = config.model;
    } else {
      const known = await listComfyuiWorkflowFilenames();
      if (known.length === 0) {
        log.error('No ComfyUI workflow files found in public/');
        throw new Error(
          'ComfyUI video: no workflow JSON files found in the public/ folder. ' +
            'Add at least one comfyui-*.json workflow.',
        );
      }
      filename = known[0];
      log.info(`No workflow specified — defaulting to first available: "${filename}"`);
    }

    const publicDir = path.join(process.cwd(), 'public');
    const filePath = path.join(publicDir, filename);

    // Defense in depth: the resolved file must stay inside public/.
    const resolvedPublicDir = path.resolve(publicDir) + path.sep;
    if (!path.resolve(filePath).startsWith(resolvedPublicDir)) {
      log.error(`Refusing to read outside public/ directory: "${filePath}"`);
      throw new Error('ComfyUI video: resolved workflow path escapes the public/ directory.');
    }

    if (!fs.existsSync(filePath)) {
      log.error(`Workflow file not found at "${filePath}"`);
      throw new Error(`ComfyUI video: workflow file not found at "${filePath}".`);
    }
    log.info(`Loading video workflow from disk: "${filePath}"`);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  }

  // Browser-side fallback (unused for real generations — they run server-side).
  const { isComfyuiWorkflowFilename } = await import('../comfyui-workflows');
  let publicPath = '/comfyui-workflow.json';
  if (config.workflowPublicPath) {
    publicPath = config.workflowPublicPath;
  } else if (config.model) {
    if (!isComfyuiWorkflowFilename(config.model)) {
      throw new Error(`ComfyUI video: "${config.model}" is not a valid workflow filename.`);
    }
    publicPath = `/${config.model}`;
  }
  const response = await fetch(`${window.location.origin}${publicPath}`);
  if (!response.ok) {
    throw new Error(`ComfyUI video: could not load workflow (HTTP ${response.status}).`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function nodeInputs(node: unknown): Record<string, unknown> | undefined {
  const inputs = (node as Record<string, unknown> | undefined)?.['inputs'];
  return inputs && typeof inputs === 'object' ? (inputs as Record<string, unknown>) : undefined;
}

function findNodeIdByTitle(workflow: Record<string, unknown>, title: string): string | undefined {
  const lower = title.toLowerCase();
  for (const [id, node] of Object.entries(workflow)) {
    const meta = (node as Record<string, unknown>)['_meta'] as Record<string, unknown> | undefined;
    if (typeof meta?.title === 'string' && meta.title.toLowerCase() === lower) {
      return id;
    }
  }
  return undefined;
}

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
 * Patch the workflow clone with the caller-supplied options.
 * Best-effort: unknown node layouts keep the workflow's own defaults at their
 * declared values; the adapter never fails a request over a missing patch.
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
    // Silent no-prompt generation is worse than a loud failure: refuse so the
    // user learns the workflow needs the conventional node title. Mirrors the
    // image adapter's contract.
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

// ---------------------------------------------------------------------------
// ComfyUI REST helpers
// ---------------------------------------------------------------------------

interface QueuePromptResponse {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

interface ComfyFile {
  filename: string;
  subfolder: string;
  type: string;
}

interface ComfyNodeOutput {
  videos?: ComfyFile[];
  gifs?: ComfyFile[];
  images?: ComfyFile[];
}

interface HistoryEntry {
  outputs: Record<string, ComfyNodeOutput>;
  status: {
    status_str: string;
    completed: boolean;
    messages?: Array<[string, Record<string, unknown>]>;
  };
}

function extractExecutionError(entry: HistoryEntry): string | undefined {
  const messages = entry.status?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (const [event, data] of messages) {
    if (event === 'execution_error' && data) {
      const nodeType = typeof data['node_type'] === 'string' ? data['node_type'] : undefined;
      const exception =
        typeof data['exception_message'] === 'string' ? data['exception_message'] : undefined;
      const parts = [nodeType, exception].filter(Boolean);
      return parts.length > 0 ? parts.join(': ') : 'execution_error';
    }
  }
  return undefined;
}

async function queuePrompt(
  baseUrl: string,
  workflow: Record<string, unknown>,
  clientId: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ComfyUI video /prompt failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as QueuePromptResponse;
  if (data.node_errors && Object.keys(data.node_errors).length > 0) {
    throw new Error(`ComfyUI video reported node errors: ${JSON.stringify(data.node_errors)}`);
  }
  log.info(`Queued successfully — prompt_id: ${data.prompt_id} (position: ${data.number})`);
  return data.prompt_id;
}

async function pollHistory(baseUrl: string, promptId: string): Promise<HistoryEntry | null> {
  try {
    const response = await fetch(`${baseUrl}/history/${promptId}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, HistoryEntry>;
    return data[promptId] ?? null;
  } catch {
    return null;
  }
}

async function fetchAsBase64(baseUrl: string, file: ComfyFile): Promise<string> {
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder,
    type: file.type,
  });
  const response = await fetch(`${baseUrl}/view?${params.toString()}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`ComfyUI video /view failed (${response.status}) for "${file.filename}"`);
  }
  const buffer = await response.arrayBuffer();
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64');
  }
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function firstMemberFile(
  entry: HistoryEntry,
  kind: 'videos' | 'gifs' | 'images',
): ComfyFile | undefined {
  for (const output of Object.values(entry.outputs ?? {})) {
    const files = output[kind];
    if (files && files.length > 0) return files[0];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function testComfyuiVideoConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
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
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const comfyConfig = config as ComfyUIVideoGenerationConfig;

  log.info(
    `Starting video generation [baseUrl: ${baseUrl}] [workflow: ${config.model ?? 'default'}]`,
  );
  log.debug(
    `Options: ${JSON.stringify({ duration: options.duration, aspectRatio: options.aspectRatio, resolution: options.resolution })}`,
  );

  const startTime = Date.now();

  // 1. Load and patch the workflow.
  const workflow = await loadWorkflow(comfyConfig);
  patchWorkflow(workflow, options);

  // 2. Client ID for this request.
  const clientId = `openmaic-video-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // 3. Submit to the queue.
  const promptId = await queuePrompt(baseUrl, workflow, clientId);

  // 4. Poll history until complete.
  const deadline = Date.now() + GENERATION_TIMEOUT_MS;
  let entry: HistoryEntry | null = null;
  let pollCount = 0;

  log.info(`Polling for completion [prompt_id: ${promptId}]`);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    pollCount += 1;
    entry = await pollHistory(baseUrl, promptId);

    if (entry?.status?.status_str === 'error') {
      const detail = extractExecutionError(entry);
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

  // 5. Extract the first video output.
  const videoFile = firstMemberFile(entry, 'videos') ?? firstMemberFile(entry, 'gifs');
  if (!videoFile) {
    throw new Error(
      'ComfyUI finished but no video output was found. ' +
        'Check that your workflow includes a SaveVideo/SaveWEBM node.',
    );
  }

  const mimeType = videoFile.filename.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4';
  log.info(`Fetching video "${videoFile.filename}" from ComfyUI /view`);
  const videoBase64 = await fetchAsBase64(baseUrl, videoFile);

  // 6. Optional poster (first image output, e.g. a preview frame).
  const posterFile = firstMemberFile(entry, 'images');
  let poster: string | undefined;
  if (posterFile) {
    try {
      poster = `data:image/jpeg;base64,${await fetchAsBase64(baseUrl, posterFile)}`;
    } catch {
      log.warn('Could not fetch ComfyUI poster frame; continuing without one.');
    }
  }

  const dims = resolveOutputDimensions(options);
  const totalMs = Date.now() - startTime;
  log.info(
    `Video complete — ${videoFile.filename} (${dims.width}x${dims.height}) in ${(totalMs / 1000).toFixed(1)}s`,
  );

  return {
    url: `data:${mimeType};base64,${videoBase64}`,
    poster,
    width: dims.width,
    height: dims.height,
    duration: options.duration ?? 5,
  };
}
