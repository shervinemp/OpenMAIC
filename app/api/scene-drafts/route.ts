import type { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import {
  clearSceneDraftsForStage,
  deleteSceneDraft,
  loadSceneDrafts,
  saveSceneDraft,
  sweepStaleSceneDrafts,
} from '@/lib/server/scene-draft-store';
import type { SceneDraftPayload } from '@/lib/utils/scene-draft-model';

export const runtime = 'nodejs';
export const maxDuration = 30;

const log = createLogger('SceneDrafts API');

/** Read (and implicitly sweep) drafts for a course. */
export async function GET(req: NextRequest): Promise<Response> {
  try {
    const stageId = req.nextUrl.searchParams.get('stageId');
    if (!stageId) {
      await sweepStaleSceneDrafts();
      return apiSuccess({ drafts: [] });
    }
    const drafts = await loadSceneDrafts(stageId);
    return apiSuccess({ drafts: [...drafts.values()] });
  } catch (error) {
    log.warn('Draft load failed:', error);
    return apiError('INTERNAL_ERROR', 500, 'Draft load failed');
  }
}

/** Store a raw content/actions payload from either generation engine. */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as {
      stageId?: string;
      outlineId?: string;
      payload?: SceneDraftPayload;
    };
    if (!body.stageId || !body.outlineId || !body.payload?.sourceKey) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId, outlineId and payload are required');
    }
    await saveSceneDraft(body.stageId, body.outlineId, body.payload);
    return apiSuccess({ saved: true });
  } catch (error) {
    log.warn('Draft save failed:', error);
    return apiError('INTERNAL_ERROR', 500, 'Draft save failed');
  }
}

/** Delete one draft, or clear the whole stage when outlineId is omitted. */
export async function DELETE(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as { stageId?: string; outlineId?: string };
    if (!body.stageId) return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
    if (body.outlineId) await deleteSceneDraft(body.stageId, body.outlineId);
    else await clearSceneDraftsForStage(body.stageId);
    return apiSuccess({ deleted: true });
  } catch (error) {
    log.warn('Draft delete failed:', error);
    return apiError('INTERNAL_ERROR', 500, 'Draft delete failed');
  }
}
