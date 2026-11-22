import { type NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { cancelAllGenerations, cancelGeneration } from '@/lib/server/generation-cancel';

const log = createLogger('GenerationCancel API');

export const dynamic = 'force-dynamic';

/**
 * Cancel the browser-driven generation flow. The generation-preview page
 * sends its session id on every generation request; aborting here stops the
 * in-flight server-side LLM calls, not just the client's fetches.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      sessionId?: unknown;
      all?: unknown;
    };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId && body.all !== true) {
      return apiError('INVALID_REQUEST', 400, 'Provide a sessionId or set all=true');
    }

    if (body.all === true) {
      const stopped = cancelAllGenerations();
      return apiSuccess({ cancelled: true, stopped, scope: 'all' });
    }

    const stopped = cancelGeneration(sessionId);
    // Idempotent: an already-finished session simply has nothing to abort.
    return apiSuccess({ cancelled: true, stopped, scope: 'session', sessionId });
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
