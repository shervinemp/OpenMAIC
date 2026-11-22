import { type NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  activeGenerationCallCountFor,
  cancelGeneration,
} from '@/lib/server/generation-cancel';

const log = createLogger('GenerationCancel API');

export const dynamic = 'force-dynamic';

/** Cancel the browser-driven generation flow for one session. */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) {
      return apiError('INVALID_REQUEST', 400, 'Provide a sessionId');
    }

    const stopped = cancelGeneration(sessionId);
    // Idempotent: an already-finished session simply has nothing to abort.
    // `remaining` lets the caller confirm the abort actually took effect.
    const remaining = activeGenerationCallCountFor(sessionId);
    return apiSuccess({ cancelled: true, stopped, remaining, sessionId });
  } catch (error) {
    log.error('Generation cancel failed:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to cancel generation',
      error instanceof Error ? error.message : String(error),
    );
  }
}
