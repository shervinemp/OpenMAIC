/**
 * Server-backed activity runtime endpoint.
 *
 * Operator-gated: disabled unless ACTIVITY_SERVER_RUNTIME_ENABLED=true and
 * ACTIVITY_DOCKER_IMAGE names a reviewed sandbox image. The route is also
 * covered by the app-wide access gate when ACCESS_CODE is configured; exposing
 * this route without one lets any visitor spend the operator's container
 * budget, so both gates are documented in .env.example.
 */
import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { readServerActivityRuntimeConfig } from '@/lib/activity/server/config';
import { validateServerActivityRunRequest } from '@/lib/activity/server/request';
import { runServerActivity } from '@/lib/activity/server/docker';
import { createLogger } from '@/lib/logger';

const log = createLogger('ActivityServerRuntime');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const config = readServerActivityRuntimeConfig();
  if (!config.enabled) {
    return apiError(
      'ACTIVITY_RUNTIME_DISABLED',
      403,
      'The server activity runtime is not enabled on this deployment.',
      'Set ACTIVITY_SERVER_RUNTIME_ENABLED=true and ACTIVITY_DOCKER_IMAGE to a reviewed sandbox image.',
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('ACTIVITY_REQUEST_INVALID', 400, 'Expected a JSON request body.');
  }

  const validation = validateServerActivityRunRequest(body, config);
  if (!validation.request) {
    return apiError(
      'ACTIVITY_REQUEST_INVALID',
      400,
      validation.error ?? 'Invalid activity request.',
    );
  }

  const outcome = await runServerActivity(validation.request, config);
  if (outcome.busy) {
    return apiError(
      'ACTIVITY_RUNTIME_BUSY',
      429,
      'The server activity runtime is at capacity. Try again in a moment.',
    );
  }
  if (!outcome.result) {
    log.error('Server activity runtime returned no result');
    return apiError('INTERNAL_ERROR', 500, 'The sandbox returned no result.');
  }
  if (outcome.result.status !== 'ok') {
    log.warn(`Sandbox session ${outcome.result.status}: ${outcome.result.error ?? 'no detail'}`);
  }
  return apiSuccess({ result: outcome.result });
}
