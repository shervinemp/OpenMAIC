/**
 * ComfyUI Workflow Discovery
 *
 * Single source of truth for "which workflow JSON files exist and are
 * selectable". Both `/api/comfyui-workflows` (lists workflows for the
 * Settings UI) and the ComfyUI image adapter (validates a client-supplied
 * workflow id before reading it from disk) import this module so the two
 * can never drift apart — a filename the UI offers is always a filename
 * the adapter will accept, and vice versa.
 *
 * Workflow files live flat in the Next.js `public/` directory and are
 * recognised by filename: must end in `.json` and either start with
 * "comfyui" or contain "workflow" (case-insensitive).
 *
 * IMPORTANT: this module is reachable from client bundles (imported by
 * the adapter, which is imported by image-providers.ts, which is imported
 * by the client-side settings store). `fs`/`path` are therefore imported
 * dynamically inside each function rather than statically at the top of
 * the file — a top-level `import ... from 'fs'` makes the bundler try to
 * resolve `fs` for the browser build too, which fails ("Module not found:
 * Can't resolve 'fs'"). The functions below are still only ever *called*
 * server-side; the dynamic import just keeps the module import-safe.
 */

export interface ComfyuiWorkflowEntry {
  id: string;
  name: string;
}

/** Convert a workflow filename to a human-readable display name. */
export function filenameToDisplayName(filename: string): string {
  return (
    filename
      .replace(/\.json$/i, '') // strip extension
      .replace(/^comfyui[-_]?/i, '') // strip leading "comfyui-" or "comfyui_"
      .replace(/[-_]+/g, ' ') // hyphens/underscores → spaces
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase()) || // title-case
    'Default Workflow'
  ); // fallback if name becomes empty
}

/**
 * Whether a filename looks like a ComfyUI workflow file, per the naming
 * convention documented above. Also rejects anything that isn't a bare
 * basename (no path separators, no "..") so this doubles as the safety
 * check for client-supplied workflow ids.
 */
export function isComfyuiWorkflowFilename(filename: string): boolean {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return false;
  }
  const lower = filename.toLowerCase();
  return lower.endsWith('.json') && (lower.startsWith('comfyui') || lower.includes('workflow'));
}

/**
 * List the workflow JSON files actually present in `public/`, with display
 * names. Returns `[]` if `public/` doesn't exist, on any read error, or if
 * called from the browser (this is server-only — see file-level note).
 *
 * Async because fs/path are loaded dynamically — callers must `await` this.
 *
 * The `typeof window === 'undefined'` guard below isn't just a runtime
 * safety check: Turbopack/webpack can statically eliminate code behind it
 * for the client bundle, which is what lets the dynamic `import('fs')`
 * resolve at all. Without the guard, the bundler can't prove this branch
 * is server-only and tries to resolve 'fs' for the browser build too,
 * which fails ("Module not found: Can't resolve 'fs'"). This matches the
 * existing pattern in comfyui-image-adapter.ts's loadWorkflow().
 */
export async function listComfyuiWorkflows(): Promise<ComfyuiWorkflowEntry[]> {
  // Server-side only — see file-level note. The `typeof window === 'undefined'`
  // guard must wrap the dynamic import directly (not an early-return above
  // it) to match the shape Turbopack already dead-code-eliminates correctly
  // in comfyui-image-adapter.ts's loadWorkflow().
  if (typeof window === 'undefined') {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const publicDir = path.join(process.cwd(), 'public');
      if (!fs.existsSync(publicDir)) return [];

      return fs
        .readdirSync(publicDir)
        .filter(
          (f) => isComfyuiWorkflowFilename(f) && fs.statSync(path.join(publicDir, f)).isFile(),
        )
        .map((filename) => ({ id: filename, name: filenameToDisplayName(filename) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.error('[ComfyUI Workflows] Failed to list workflows:', err);
      return [];
    }
  }

  return [];
}

/** Just the filenames, for allowlist membership checks. */
export async function listComfyuiWorkflowFilenames(): Promise<string[]> {
  const workflows = await listComfyuiWorkflows();
  return workflows.map((w) => w.id);
}

/** Node classes that mark a workflow as producing video (vs. still images). */
const VIDEO_OUTPUT_CLASSES = new Set([
  'SaveVideo',
  'CreateVideo',
  'SaveWEBM',
  'SaveAnimatedWEBP',
  'MiniMaxH3ImageToVideo',
  'VHS_VideoCombine',
  'SaveGif',
]);

/** Pure selection logic, separated from the fs/JSON parsing for testability. */
export function pickComfyuiWorkflowByOutput(
  candidates: Array<{ filename: string; workflow: Record<string, unknown> }>,
  prefer: 'image' | 'video',
): string | undefined {
  for (const { filename, workflow } of candidates) {
    const classes = Object.values(workflow).map((node) =>
      typeof (node as Record<string, unknown>)?.['class_type'] === 'string'
        ? String((node as Record<string, unknown>)['class_type'])
        : '',
    );
    const hasVideo = classes.some((c) => VIDEO_OUTPUT_CLASSES.has(c));
    const hasImage = classes.includes('SaveImage');
    if (prefer === 'image' && hasImage && !hasVideo) return filename;
    if (prefer === 'video' && hasVideo) return filename;
  }
  return undefined;
}

/**
 * Pick the workflow to use when none was explicitly selected. Workflows of
 * the wrong medium must never be auto-picked: without this, the first
 * `comfyui-*.json` alphabetically could be a video workflow (e.g.
 * `comfyui-minimax-h3.json`), and an image generation would try to run it —
 * loading a huge video model and OOMing. Returns the first filename whose
 * node classes match `prefer` ('image' = has an image output, no video
 * outputs; 'video' = has a video output), falling back to the first
 * discovered filename when nothing matches.
 *
 * Server-side only (reads from public/), like listComfyuiWorkflows.
 */
export async function defaultComfyuiWorkflowFilename(
  prefer: 'image' | 'video',
): Promise<string | undefined> {
  if (typeof window === 'undefined') {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const filenames = await listComfyuiWorkflowFilenames();
      if (filenames.length === 0) return undefined;

      const candidates: Array<{ filename: string; workflow: Record<string, unknown> }> = [];
      for (const filename of filenames) {
        try {
          const raw = fs.readFileSync(path.join(process.cwd(), 'public', filename), 'utf-8');
          candidates.push({ filename, workflow: JSON.parse(raw) as Record<string, unknown> });
        } catch {
          continue; // unreadable/unparseable workflow is never a safe default
        }
      }

      return pickComfyuiWorkflowByOutput(candidates, prefer) ?? filenames[0];
    } catch (err) {
      console.error('[ComfyUI Workflows] Failed to pick default workflow:', err);
      return undefined;
    }
  }

  return undefined;
}
