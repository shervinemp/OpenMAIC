/**
 * Generic semantic audit for generated scene content.
 *
 * Structural validators only prove shape and count: a worked solution can be
 * present, well-formatted and still wrong. This module adds one shared,
 * fail-open audit path for every structured scene kind instead of a bespoke
 * verifier per kind. It deliberately excludes the kinds that already have a
 * dedicated verifier (quizzes, widgets) so a course is not audited twice.
 *
 * The audit is an independent *read* of the generated payload, not a blind
 * solve: free-text solutions have no canonical form to compare against. The
 * guarantees are the same as quiz verification — structured verdict, bounded
 * corrective pass, and keeping the generated content when verification is
 * inconclusive.
 */

import { parseJsonResponse } from './json-repair.js';
import type { AICallFn } from './pipeline-types.js';

export interface SceneAuditIssue {
  code: string;
  message: string;
}

export interface SceneAuditContext {
  sceneId: string;
  kind: string;
  title: string;
  description: string;
  keyPoints: readonly string[];
  /** Learner-facing projection of the generated payload, never the raw scene. */
  payload: unknown;
}

export type SceneAuditor = (
  context: SceneAuditContext,
) => Promise<readonly SceneAuditIssue[] | null | undefined>;

const MAX_PROJECTION_CHARS = 12000;
const MAX_ISSUES = 5;
const MAX_MESSAGE_CHARS = 400;

const DROP_KEYS = new Set([
  'id',
  'sceneId',
  'src',
  'mediaRef',
  'assetId',
  'imageIds',
  'referenceFiles',
  'style',
  'layout',
  'position',
  'x',
  'y',
  'width',
  'height',
  'color',
  'fontSize',
]);

/**
 * Project a content payload to the prose and structure an auditor needs.
 * Authoring-only fields (notably `referenceFiles`) are removed so the auditor
 * cannot simply agree with the generator's own answer key.
 */
export function projectSceneContent(content: unknown): unknown {
  function visit(value: unknown, depth: number): unknown {
    if (depth > 8) return undefined;
    if (typeof value === 'string') return value.slice(0, MAX_PROJECTION_CHARS);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) return value.slice(0, 40).map((item) => visit(item, depth + 1));
    if (value !== null && typeof value === 'object') {
      const projected: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (DROP_KEYS.has(key)) continue;
        const seen = visit(child, depth + 1);
        if (seen !== undefined) projected[key] = seen;
      }
      return projected;
    }
    return undefined;
  }
  return visit(content, 0);
}

/** Build the auditor prompt. The payload is a projection, never raw storage. */
export function buildSceneAuditPrompt(context: SceneAuditContext): {
  system: string;
  user: string;
} {
  const system = [
    'You are an independent content auditor for an educational lesson.',
    'You see the scene outline claims and the generated learner-facing content.',
    'Report only concrete defects supported by that content:',
    '- a worked solution that does not solve its own problem;',
    '- a rubric or debrief that contradicts the task or its sample answer;',
    '- internally inconsistent numbers, units, labels or definitions;',
    '- a claim that is false or unsupported by anything stated in the scene.',
    'Do not rewrite the scene and do not comment on style, layout or language.',
    `Reply with ONLY a JSON array: [{"code":"wrong-solution","message":"..."}].`,
    `Return [] when you find no concrete defect. At most ${MAX_ISSUES} issues; each message at most ${MAX_MESSAGE_CHARS} characters.`,
  ].join('\n');

  const user = JSON.stringify(
    {
      sceneId: context.sceneId,
      kind: context.kind,
      title: context.title,
      description: context.description,
      keyPoints: context.keyPoints,
      content: context.payload,
    },
    null,
    2,
  ).slice(0, MAX_PROJECTION_CHARS * 2);
  return { system, user };
}

function normalizeIssues(parsed: unknown): SceneAuditIssue[] {
  if (!Array.isArray(parsed)) return [];
  const issues: SceneAuditIssue[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code.trim() : '';
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    if (!code || !message) continue;
    issues.push({ code: code.slice(0, 60), message: message.slice(0, MAX_MESSAGE_CHARS) });
    if (issues.length >= MAX_ISSUES) break;
  }
  return issues;
}

/** Auditor backed by the generation call handle, so it runs without a route. */
export function createAiSceneAuditor(aiCall: AICallFn): SceneAuditor {
  return async (context) => {
    const { system, user } = buildSceneAuditPrompt(context);
    return normalizeIssues(parseJsonResponse<unknown>(await aiCall(system, user)));
  };
}

/** Fail-open wrapper: a missing, malformed or failed verdict is no signal. */
export async function verifySceneSafely(
  auditor: SceneAuditor | undefined,
  context: SceneAuditContext,
  log?: { warn: (message: string) => void },
): Promise<SceneAuditIssue[]> {
  if (!auditor) return [];
  try {
    const verdict = await auditor(context);
    return verdict ? normalizeIssues(verdict) : [];
  } catch (error) {
    log?.warn(
      `Scene audit failed for "${context.title}"; keeping generated content: ${String(error)}`,
    );
    return [];
  }
}

/** Model-facing feedback for the single corrective pass. */
export function summarizeSceneAuditIssues(issues: readonly SceneAuditIssue[]): string {
  return [
    'Your previous draft was audited and found to contain these concrete defects:',
    ...issues.map((issue) => `- [${issue.code}] ${issue.message}`),
    'Correct them and reply with the complete scene content in the required format.',
  ].join('\n');
}
