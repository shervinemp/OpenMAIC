import { copyFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createLogger } from '@/lib/logger';
import {
  collectDocumentMediaRefs as sharedCollectDocumentMediaRefs,
  isNarrationRefShape,
} from '@/lib/media/document-media-refs';

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
 * The manifest doubles as the auditable self-containment report: with it
 * committed, "does this repo contain the full course?" is answerable by
 * `git status` alone — every declared media ref either has bytes beside it or
 * is listed as missing (nothing is silently half-shipped).
 *
 * Copy, not move: the persistence store stays the source of truth (same
 * direction as git-course-sync.ts — history is best-effort).
 */

export interface StageAssetMaterials {
  stageId: string;
  /** Relative repo-side asset directory for this stage's media. */
  assetDir: string;
  /** Narration refs the document declares (speech/audio ids). */
  narrationDeclared: number;
  /** Narration refs with resolvable server bytes. */
  narrationIncluded: number;
  /** Generated-media refs (images/videos/posters) declared. */
  mediaDeclared: number;
  /** Generated-media refs whose bytes shipped into the repo. */
  mediaIncluded: number;
  /** Refs missing server-side bytes — the browser backfill's work list. */
  missing: string[];
}

/** Every media ref the document references. Shared walker — defined once. */
export function collectDocumentMediaRefs(document: unknown): string[] {
  return sharedCollectDocumentMediaRefs(document);
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
  const narrationRefs = refs.filter(isNarrationRefShape);
  const mediaRefs = refs.filter((ref) => !isNarrationRefShape(ref));
  const narrationIncluded: string[] = [];
  const mediaIncluded: string[] = [];
  const missing: string[] = [];

  for (const ref of refs) {
    const encoded = encodeURIComponent(ref);
    try {
      await copyFile(join(sources.bytes, encoded), join(targets.bytes, ref));
      (isNarrationRefShape(ref) ? narrationIncluded : mediaIncluded).push(ref);
    } catch {
      missing.push(ref);
      continue;
    }
    try {
      await copyFile(join(sources.meta, `${encoded}.json`), join(targets.meta, `${ref}.json`));
    } catch {
      // Bytes exist without a meta sidecar: emit a minimal one so import is
      // uniform.
      await writeFile(
        join(targets.meta, `${ref}.json`),
        JSON.stringify({ mime: 'application/octet-stream', meta: {}, size: null }),
        'utf8',
      );
    }
  }

  // Self-containment report, written INSIDE the repo: every declared ref is
  // either present (`assets/<stageId>/<ref>`) or listed by name — a missing
  // ref is a decision the operator can audit, not an accident the importer
  // discovers later.
  const manifest = {
    stageId,
    materialization: {
      narration: {
        declared: narrationRefs.length,
        included: narrationIncluded.length,
        missing: narrationRefs.length - narrationIncluded.length,
      },
      media: {
        declared: mediaRefs.length,
        included: mediaIncluded.length,
        missing: mediaRefs.length - mediaIncluded.length,
      },
    },
    totalRefs: refs.length,
    missingRefs: missing,
    missingNote:
      missing.length > 0
        ? 'Refs listed here have bytes neither in this repo nor server-side. Restore the course by materializing them (browser media backfill, or regeneration through the media orchestrator), then re-save the course to re-commit.'
        : 'Course is fully materialized: every declared media ref has bytes committed beside this document.',
    generatedAt: new Date().toISOString(),
  };
  await writeFile(join(repoPath, assetDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  if (missing.length > 0) {
    log.warn(
      `Stage ${JSON.stringify(stageId)}: ${missing.length}/${refs.length} media ref(s) have no server-side bytes; run the browser media backfill`,
    );
  }

  return {
    stageId,
    assetDir,
    narrationDeclared: narrationRefs.length,
    narrationIncluded: narrationIncluded.length,
    mediaDeclared: mediaRefs.length,
    mediaIncluded: mediaIncluded.length,
    missing,
  };
}

/** Repo-side path of a stage's asset directory (for consumers/tests). */
export function stageAssetDir(stageId: string): string {
  return join('assets', stageId);
}
