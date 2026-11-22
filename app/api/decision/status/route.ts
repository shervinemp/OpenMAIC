/**
 * Operator diagnostics for the optional decision layer.
 *
 * System 1 has no server-side config: the single choice is made in Settings
 * and sent per request, so this endpoint reports telemetry only.
 *
 * Gated by the same dev persistence token as the course-maintenance routes.
 */

import { NextRequest } from 'next/server';

import { decisionTelemetryFile } from '@/lib/decision/telemetry-file';
import { snapshotDecisionTelemetry } from '@/lib/decision/telemetry';
import { DECISION_SITES } from '@/lib/decision/types';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { isMaintenanceUnauthorized } from '@/lib/server/maintenance-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (isMaintenanceUnauthorized(req)) {
    return apiError(
      'UNAUTHENTICATED',
      401,
      'decision diagnostics require the dev persistence token',
    );
  }

  return apiSuccess({
    source: 'settings',
    sites: [...DECISION_SITES],
    telemetry: snapshotDecisionTelemetry(),
    telemetryFile: decisionTelemetryFile(),
  });
}
