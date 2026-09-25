import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { authenticatePersistenceHeaders } from '@/lib/persistence/server-auth';
import { getCourseBinding } from '@/lib/persistence/git-course-sync';
import {
  collectDocumentMediaRefs,
  isNarrationRefShape,
} from '@/lib/media/document-media-refs';

/**
 * GET /api/course-git/report — live course materialization report.
 *
 * Answers "is this course self-contained right now?" per asset class: for
 * EVERY media ref the persisted document declares, does the server asset
 * store actually hold its bytes right now? Plus, when the course is bound to
 * a repo, the committed repo-side materialization manifest (what the last
 * course-git snapshot shipped).
 *
 * Pure read — no writes, no materialization side effects. The bound repo's
 * committed manifest is the auditable snapshot truth; this endpoint's counts
 * are the live server truth (they can differ briefly between a save's
 * re-upload and the next commit).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const dir = process.env.PERSISTENCE_DIR?.trim();
  if (!dir) {
    return Response.json({ error: { code: 'GIT_SYNC_UNAVAILABLE', message: 'PERSISTENCE_DIR is not configured' } }, { status: 503 });
  }
  if (!(await authenticatePersistenceHeaders(request.headers))) {
    return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'server persistence requires authentication' } }, { status: 401 });
  }
  const stageId = new URL(request.url).searchParams.get('stageId');
  if (!stageId) {
    return Response.json({ error: { code: 'INVALID_STAGE_ID', message: 'stageId is required' } }, { status: 400 });
  }

  const binding = await getCourseBinding(dir, stageId);
  const docPath = join(dir, 'documents', `${stageId}.json`);
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(docPath, 'utf8'));
  } catch {
    return Response.json(
      { error: { code: 'DOCUMENT_NOT_PERSISTED', message: 'no server-persisted document for this stage' } },
      { status: 404 },
    );
  }

  const refs = collectDocumentMediaRefs(document);
  const narrationDeclared = refs.filter(isNarrationRefShape);
  const mediaDeclared = refs.filter((ref) => !isNarrationRefShape(ref));
  const hasBytes = (ref: string): boolean =>
    existsSync(join(dir, 'assets', encodeURIComponent(ref)));
  const narrationOnServer = narrationDeclared.filter(hasBytes);
  const mediaOnServer = mediaDeclared.filter(hasBytes);
  const missing = refs.filter((ref) => !hasBytes(ref));

  // Repo-side committed manifest (the last full-course snapshot's audit).
  let repoManifest: unknown = null;
  if (binding) {
    try {
      repoManifest = JSON.parse(
        readFileSync(join(binding.repoPath, 'assets', stageId, 'manifest.json'), 'utf8'),
      );
    } catch {
      repoManifest = null;
    }
  }

  return Response.json({
    stageId,
    narration: {
      declared: narrationDeclared.length,
      onServer: narrationOnServer.length,
    },
    media: {
      declared: mediaDeclared.length,
      onServer: mediaOnServer.length,
    },
    missingRefs: missing,
    repository: repoManifest,
  });
}
