/**
 * Operator diagnostics for the optional decision layer.
 *
 * GET  — configured sites, process counters, and shadow agreement.
 * POST — one connectivity probe per configured typed site.
 *
 * Gated by the same dev persistence token as the course-maintenance routes.
 * With no token configured the route refuses every request, so a deployment
 * that never opted into operator routes also never exposes its decision
 * endpoints. Telemetry carries no learner text; the probe request is fixed and
 * learner-free.
 */

import { NextRequest } from 'next/server';

import { decisionModelsEnabled, loadDecisionConfigs } from '@/lib/decision/config';
import { probeDecisionSites } from '@/lib/decision/probe';
import { decisionTelemetryFile } from '@/lib/decision/telemetry-file';
import { snapshotDecisionTelemetry } from '@/lib/decision/telemetry';
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

  const sites = [...loadDecisionConfigs().values()].map((config) => ({
    site: config.site,
    provider: config.provider,
    mode: config.mode,
    fallback: config.fallback,
    timeoutMs: config.timeoutMs,
    minConfidence: config.minConfidence,
    maxInputChars: config.maxInputChars,
    ...(config.model ? { model: config.model } : {}),
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  }));

  return apiSuccess({
    enabled: decisionModelsEnabled(),
    sites,
    telemetry: snapshotDecisionTelemetry(),
    telemetryFile: decisionTelemetryFile(),
  });
}

export async function POST(req: NextRequest) {
  if (isMaintenanceUnauthorized(req)) {
    return apiError(
      'UNAUTHENTICATED',
      401,
      'decision diagnostics require the dev persistence token',
    );
  }

  const probes = await probeDecisionSites({ signal: req.signal });
  return apiSuccess({ probes });
}
