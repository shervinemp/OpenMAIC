'use client';

import {
  getPersistenceRequestHeaders,
  isBrowserPersistenceEnabled,
} from '@/lib/persistence/bootstrap';

/**
 * Thin client for the course-git binding API (`/api/course-git`), shared by
 * the per-course header dialog and the Settings overview card.
 *
 * `bindCourseToRepo` mirrors the server `DocumentStore` semantics: binding is
 * bookkeeping that can never fail a course save, so server-side errors are
 * returned as `{ ok: false, message }` instead of thrown.
 */

export interface CourseBinding {
  stageId: string;
  repoPath: string;
  boundAt: number;
  autoLoad?: boolean;
}

/** One repo-vs-persistence comparison row (server-side snapshot scan). */
export interface RepoUpdateEntry {
  stageId: string;
  title: string;
  sceneCount: number;
  repoPath: string;
  state: 'new' | 'equal' | 'update' | 'invalid';
}

/** POST /api/course-git/sync outcome row (approval confluence). */
export interface SyncStageResult {
  stageId: string;
  action: 'imported' | 'applied' | 'equal' | 'skipped' | 'rejected';
  detail: string;
}

export interface CourseSummary {
  id: string;
  name: string;
}

async function courseGitFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`/api/course-git${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(await getPersistenceRequestHeaders()),
    },
  });
}

/** Bind the stage. Returns the binding on success, else an error message. */
export async function bindCourseToRepo(body: {
  stageId: string;
  repoPath: string;
  init: boolean;
}): Promise<{ ok: true; binding: CourseBinding } | { ok: false; message: string }> {
  const response = await courseGitFetch('', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as {
    binding?: CourseBinding;
    error?: { message?: string };
  };
  if (response.ok && data.binding) return { ok: true, binding: data.binding };
  return { ok: false, message: data.error?.message ?? 'connecting failed' };
}

/** Remove the binding. `false` means there was nothing to remove. */
export async function unbindCourseRepo(stageId: string): Promise<boolean> {
  const response = await courseGitFetch(`?stageId=${encodeURIComponent(stageId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) return false;
  const data = (await response.json().catch(() => ({}))) as { removed?: boolean };
  return data.removed === true;
}

export async function getCourseBinding(stageId: string): Promise<CourseBinding | null> {
  const response = await courseGitFetch(`?stageId=${encodeURIComponent(stageId)}`);
  if (!response.ok) return null;
  const data = (await response.json().catch(() => ({}))) as { binding?: CourseBinding | null };
  return data.binding ?? null;
}

export async function listCourseBindings(): Promise<CourseBinding[]> {
  const response = await courseGitFetch('');
  if (!response.ok) return [];
  const data = (await response.json().catch(() => ({}))) as { bindings?: CourseBinding[] };
  return data.bindings ?? [];
}

/** Unbound courses for the Settings overview card's picker. */
export async function listUnboundCourses(): Promise<CourseSummary[]> {
  const [bindings, stages] = await Promise.all([
    listCourseBindings(),
    (async () => {
      const { listStages } = await import('@/lib/utils/stage-storage');
      return listStages();
    })(),
  ]);
  const bound = new Set(bindings.map((binding) => binding.stageId));
  return stages
    .filter((stage) => !bound.has(stage.id))
    .map((stage) => ({ id: stage.id, name: stage.name }));
}

export function isGitSyncAvailable(): boolean {
  return isBrowserPersistenceEnabled();
}

/**
 * Update scan (diff-first, never applies). `pull` is env-gated server-side.
 */
export async function scanRepoUpdates(): Promise<
  { ok: true; updates: RepoUpdateEntry[] } | { ok: false; message: string }
> {
  const response = await courseGitFetch('?sync=true');
  const data = (await response.json().catch(() => ({}))) as {
    updates?: RepoUpdateEntry[];
    error?: { message?: string };
  };
  if (!response.ok) {
    return { ok: false, message: data.error?.message ?? 'update scan failed' };
  }
  return { ok: true, updates: data.updates ?? [] };
}

/** Approval confluence: apply repo updates and/or import autoLoad courses. */
export async function applyRepoSync(body: {
  apply?: boolean;
  importNew?: boolean;
  stageIds?: string[];
}): Promise<{ ok: true; results: SyncStageResult[] } | { ok: false; message: string }> {
  const response = await courseGitFetch('/sync', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as {
    results?: SyncStageResult[];
    error?: { message?: string };
  };
  if (!response.ok) {
    return { ok: false, message: data.error?.message ?? 'apply failed' };
  }
  return { ok: true, results: data.results ?? [] };
}
