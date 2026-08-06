/**
 * Shared building blocks for the ComfyUI image/video adapters.
 *
 * Both adapters talk to the same ComfyUI REST API (/prompt, /history, /view,
 * /system_stats) and must agree on the exact hardening contract — workflow
 * selection via the public/ allowlist (no path traversal), per-request timeouts,
 * node-title patching, and error extraction. This module is the single copy of
 * that agreement; the image adapter will migrate here as it is touched, but the
 * video adapter already consumes it.
 */

export const DEFAULT_COMFYUI_BASE_URL = 'http://localhost:8188';

/** A file handle returned by /history for a node output (video, gif, image). */
export interface ComfyNodeFile {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyNodeOutput {
  videos?: ComfyNodeFile[];
  gifs?: ComfyNodeFile[];
  images?: ComfyNodeFile[];
}

export interface ComfyHistoryEntry {
  outputs: Record<string, ComfyNodeOutput>;
  status: {
    status_str: string;
    completed: boolean;
    messages?: Array<[string, Record<string, unknown>]>;
  };
}

export interface ComfyWorkflowLoadOptions {
  /** Shown in error messages, e.g. "announce" for offline deployments. */
  label: string;
  /** Pre-parsed workflow (deep-cloned per request). */
  workflowJson?: Record<string, unknown>;
  /** Client-controlled workflow basename (allowlist-checked against public/). */
  model?: string;
  /** Server-set basename override (not client-controlled). */
  workflowPublicPath?: string;
}

/**
 * Safely return a workflow node's `inputs` object, or undefined if malformed.
 */
export function nodeInputs(node: unknown): Record<string, unknown> | undefined {
  const inputs = (node as Record<string, unknown> | undefined)?.['inputs'];
  return inputs && typeof inputs === 'object' ? (inputs as Record<string, unknown>) : undefined;
}

/** First node id whose _meta.title matches (case-insensitive). */
export function findNodeIdByTitle(
  workflow: Record<string, unknown>,
  title: string,
): string | undefined {
  const lower = title.toLowerCase();
  for (const [id, node] of Object.entries(workflow)) {
    const meta = (node as Record<string, unknown>)['_meta'] as Record<string, unknown> | undefined;
    if (typeof meta?.title === 'string' && meta.title.toLowerCase() === lower) {
      return id;
    }
  }
  return undefined;
}

/**
 * Load and deep-clone a workflow with the hardened selection contract:
 *  1. `workflowJson` wins when supplied.
 *  2. A `model` id must pass the safe-basename check AND be present in
 *     listComfyuiWorkflowFilenames() — anything else is rejected, never
 *     silently ignored, so a caller can't probe the filesystem.
 *  3. Otherwise default to the first discovered `comfyui-*.json`.
 *
 * The resolved path must remain inside public/ (path.join is not a
 * traversal guard; this explicit check is).
 */
export async function loadComfyWorkflow(
  options: ComfyWorkflowLoadOptions,
): Promise<Record<string, unknown>> {
  const label = options.label || 'ComfyUI';

  if (options.workflowJson) {
    return JSON.parse(JSON.stringify(options.workflowJson)) as Record<string, unknown>;
  }

  if (typeof window === 'undefined') {
    const fs = await import('fs');
    const path = await import('path');
    const { isComfyuiWorkflowFilename, listComfyuiWorkflowFilenames } =
      await import('../comfyui-workflows');

    let filename: string;
    if (options.workflowPublicPath) {
      filename = path.basename(options.workflowPublicPath);
    } else if (options.model) {
      if (!isComfyuiWorkflowFilename(options.model)) {
        throw new Error(
          `${label}: "${options.model}" is not a valid workflow filename. ` +
            'Expected a bare comfyui-*.json basename.',
        );
      }
      const known = await listComfyuiWorkflowFilenames();
      if (!known.includes(options.model)) {
        throw new Error(
          `${label}: workflow "${options.model}" was not found. ` +
            'Choose one returned by /api/comfyui-workflows.',
        );
      }
      filename = options.model;
    } else {
      const known = await listComfyuiWorkflowFilenames();
      if (known.length === 0) {
        throw new Error(
          `${label}: no workflow JSON files found in the public/ folder. ` +
            'Add at least one comfyui-*.json workflow.',
        );
      }
      filename = known[0];
      console.info(
        `[INFO]  [ComfyUI-${label}] No workflow specified — defaulting to "${filename}"`,
      );
    }

    const publicDir = path.join(process.cwd(), 'public');
    const filePath = path.join(publicDir, filename);

    const resolvedPublicDir = path.resolve(publicDir) + path.sep;
    if (!path.resolve(filePath).startsWith(resolvedPublicDir)) {
      throw new Error(`${label}: resolved workflow path escapes the public/ directory.`);
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`${label}: workflow file not found at "${filePath}".`);
    }
    console.info(`[INFO] [ComfyUI-${label}] Loading workflow from "${filePath}"`);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  }

  // Browser-side fallback (generations always run server-side).
  const { isComfyuiWorkflowFilename } = await import('../comfyui-workflows');
  let publicPath = '/comfyui-workflow.json';
  if (options.workflowPublicPath) {
    publicPath = options.workflowPublicPath;
  } else if (options.model) {
    if (!isComfyuiWorkflowFilename(options.model)) {
      throw new Error(`${label}: "${options.model}" is not a valid workflow filename.`);
    }
    publicPath = `/${options.model}`;
  }
  const response = await fetch(`${window.location.origin}${publicPath}`);
  if (!response.ok) {
    throw new Error(`${label}: could not fetch workflow (HTTP ${response.status}).`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function queueComfyPrompt(
  baseUrl: string,
  workflow: Record<string, unknown>,
  clientId: string,
  timeoutMs: number,
): Promise<string> {
  const response = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ComfyUI /prompt failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as {
    prompt_id: string;
    node_errors?: Record<string, unknown>;
  };
  if (data.node_errors && Object.keys(data.node_errors).length > 0) {
    throw new Error(`ComfyUI reported node errors: ${JSON.stringify(data.node_errors)}`);
  }
  return data.prompt_id;
}

/** A single poll; transient failures return null so the caller can retry. */
export async function pollComfyHistory(
  baseUrl: string,
  promptId: string,
  timeoutMs: number,
): Promise<ComfyHistoryEntry | null> {
  try {
    const response = await fetch(`${baseUrl}/history/${promptId}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, ComfyHistoryEntry>;
    return data[promptId] ?? null;
  } catch {
    return null;
  }
}

/** Pull a human-readable reason out of a failed history entry, or undefined. */
export function extractComfyExecutionError(entry: ComfyHistoryEntry): string | undefined {
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

/** Download `/view` output as base64 (single native Buffer pass server-side). */
export async function fetchComfyFileAsBase64(
  baseUrl: string,
  file: ComfyNodeFile,
  timeoutMs: number,
): Promise<string> {
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder,
    type: file.type,
  });
  const response = await fetch(`${baseUrl}/view?${params.toString()}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`ComfyUI /view failed (${response.status}) for "${file.filename}"`);
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

/** First file of a given kind across every node output. */
export function firstComfyMemberFile(
  entry: ComfyHistoryEntry,
  kind: 'videos' | 'gifs' | 'images',
): ComfyNodeFile | undefined {
  for (const output of Object.values(entry.outputs ?? {})) {
    const files = output[kind];
    if (files && files.length > 0) return files[0];
  }
  return undefined;
}
