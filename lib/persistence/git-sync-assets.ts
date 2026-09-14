import { copyFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createLogger } from '@/lib/logger';

const log = createLogger('GitSyncAssets');

/**
 * Media payload for the course git snapshot (the "full course" export).
 *
 * The document JSON alone is not a portable course: scenes reference media
 * assets (TTS narration ids, generated images/videos) whose bytes live in the
 * server's asset store (`<PERSISTENCE_DIR>/assets/<encoded ref>` plus a
 * `.meta/<encoded ref>.json` sidecar). Every asset the server can resolve is
 * copied next to the stage snapshot as `assets/<stageId>/<ref>` (+ meta), and
 * everything unresolvable is listed in the stage's manifest so the browser
 * backfill uploader knows exactly which media to hand the server first.
 *
 * Copy, not move: the persistence store stays the source of truth (same
 * direction as git-course-sync.ts — history is best-effort).
 */

export interface StageAssetMaterials {
  stageId: string;
  /** Relative repo-side asset directory for this stage's media. */
  assetDir: string;
  included: number;
  /** Refs missing server-side bytes — the browser backfill's work list. */
  missing: string[];
}

function refIsMediaCandidate(value: string): boolean {
  if (/^\/assets\//.test(value)) {
    // Scene elements sometimes carry the pool URL path rather than the raw
    // ref: strip it, the effective ref is the last segment.
    return /^[A-Za-z0-9_.-]+$/.test(decodeURIComponent(value.slice('/assets/'.length)));
  }
  return (
    /^[A-Za-z0-9_.-]+$/.test(value) &&
    !value.startsWith('data:') &&
    !/^https?:/.test(value) &&
    !/^[A-Za-z]:[\\/]/.test(value)
  );
}

function normalizeRef(value: string): string {
  const stripped = value.startsWith('/assets/') ? decodeURIComponent(value.slice('/assets/'.length)) : value;
  // Placeholders (media orchestrator ids like gen_img_1) are generation-time
  // promises, not media: they carry no bytes anywhere, so a missing entry for
  // a placeholder is never expected to be satisfiable.
  return stripped;
}

/** Every media ref the document references. Opaque-walk, no DSL knowledge. */
export function collectDocumentMediaRefs(document: unknown): string[] {
  const refs = new Set<string>();
  const mediaKeys = new Set(['src', 'audioId', 'audioRef', 'elementId']);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child);
        if (mediaKeys.has(key) && typeof child === 'string' && refIsMediaCandidate(child)) {
          refs.add(normalizeRef(child));
        }
      }
    }
  };
  visit(document);
  return [...refs];
}

export async function materializeStageAssets(
  persistenceDir: string,
  repoPath: string,
  stageId: string,
  document: unknown,
): Promise<StageAssetMaterials> {
  const assetDir = join('assets', stageId);
  const sources = {
    bytes: join(persistenceDir, 'assets'),
    meta: join(persistenceDir, 'assets', '.meta'),
  };
  const targets = {
    bytes: join(repoPath, assetDir),
    meta: join(repoPath, assetDir, '.meta'),
  };
  for (const dir of [targets.bytes, targets.meta]) {
    await mkdir(dir, { recursive: true });
  }

  const refs = collectDocumentMediaRefs(document);
  const included: string[] = [];
  const missing: string[] = [];

  for (const ref of refs) {
    const encoded = encodeURIComponent(ref);
    try {
      await copyFile(join(sources.bytes, encoded), join(targets.bytes, ref));
      included.push(ref);
    } catch {
      missing.push(ref);
      continue;
    }
    try {
      await copyFile(join(sources.meta, `${encoded}.json`), join(targets.meta, `${ref}.json`));
    } catch {
      // Bytes exist without a meta sidecar: emit a minimal one so import is
      // uniform.
      await writeFile(join(targets.meta, `${ref}.json`), JSON.stringify({ mime: 'application/octet-stream', meta: {}, size: null }), 'utf8');
    }
  }

  const manifestPath = join(repoPath, assetDir, 'manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify(
      { stageId, includedCount: included.length, missingCount: missing.length, missing },
      null,
      2,
    ),
    'utf8',
  );
  if (missing.length > 0) {
    log.warn(
      `Stage ${JSON.stringify(stageId)}: ${missing.length}/${refs.length} media ref(s) have no server-side bytes; run the browser media backfill`,
    );
  }

  return { stageId, assetDir, included: included.length, missing };
}

/** Repo-side path of a stage's asset directory (for consumers/tests). */
export function stageAssetDir(stageId: string): string {
  return join('assets', stageId);
}

