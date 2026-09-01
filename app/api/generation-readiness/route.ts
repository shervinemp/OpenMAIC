import { NextRequest, NextResponse } from 'next/server';

/**
 * Generation readiness pre-flight.
 *
 * The generation flow can burn a lot of LLM tokens before the first image
 * request discovers that ComfyUI is not running (or that no workflow was ever
 * selected), or narrate scenes against a dead TTS server. The client sends
 * what only it knows (which modalities are enabled, the chosen providers, the
 * ComfyUI base URLs, whether a workflow/model is picked); this route probes
 * what only the server should probe (provider reachability) and reports a
 * per-modality status. Advisory, never blocking - the client decides.
 */

export const runtime = 'nodejs';

type ReadinessStatus = 'ready' | 'unreachable' | 'unconfigured' | 'auth_error' | 'unknown';

interface ReadinessCheck {
  key: 'llm' | 'image' | 'video' | 'tts';
  status: ReadinessStatus;
  detail?: string;
}

interface ModalityInput {
  enabled: boolean;
  providerId?: string;
  baseUrl?: string;
  /** For ComfyUI modalities: has any workflow/model been picked? */
  modelSelected?: boolean;
}

async function probe(url: string, headers: Record<string, string> = {}, timeoutMs = 4000): Promise<'reachable' | 'auth_error' | 'unreachable' | 'unknown'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (res.status === 401 || res.status === 403) return 'auth_error';
    return 'reachable';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

async function probeLlm(providerId: string, modelId: string): Promise<ReadinessCheck> {
  const configured = process.env.OPENMAIC_FALLBACK_MODEL; // presence check only
  void configured;
  const prefix = providerId.toUpperCase().replace(/-/g, '_');
  const base = process.env[`${prefix}_BASE_URL`];
  const key = process.env[`${prefix}_API_KEY`];
  // Server-managed provider without a probeable base: config presence is the
  // best signal (resolveModel happens per request and surfaces its own errors).
  if (!base) {
    if (key) return { key: 'llm', status: 'ready', detail: `${providerId} configured (server-side)` };
    return { key: 'llm', status: 'unconfigured', detail: `no ${prefix}_API_KEY/BASE_URL on the server` };
  }
  const probeUrl = `${base.replace(/\/+$/, '')}/models`;
  const reachability = await probe(probeUrl, key ? { Authorization: `Bearer ${key}` } : {});
  if (reachability === 'unreachable') {
    return { key: 'llm', status: 'unreachable', detail: `${providerId} base URL did not respond (${base})` };
  }
  if (reachability === 'auth_error') {
    return { key: 'llm', status: 'auth_error', detail: `${providerId} rejected the server API key` };
  }
  void modelId;
  return { key: 'llm', status: 'ready', detail: `${providerId} reachable` };
}

async function probeComfy(label: 'image' | 'video' | 'tts', input: ModalityInput): Promise<ReadinessCheck> {
  if (!input.baseUrl) {
    return {
      key: label,
      status: 'unconfigured',
      detail: 'ComfyUI server URL is not set in settings',
    };
  }
  if (input.modelSelected === false) {
    return {
      key: label,
      status: 'unconfigured',
      detail: `ComfyUI reachable? not checked - no workflow/model selected yet (${input.baseUrl})`,
    };
  }
  const reachability = await probe(`${input.baseUrl.replace(/\/+$/, '')}/system_stats`);
  if (reachability === 'unreachable') {
    return {
      key: label,
      status: 'unreachable',
      detail: `ComfyUI is not responding at ${input.baseUrl} - start it, or disable ${label} generation`,
    };
  }
  return { key: label, status: 'ready', detail: `ComfyUI reachable at ${input.baseUrl}` };
}

function isComfy(providerId: string | undefined): boolean {
  return providerId === 'comfyui-image' || providerId === 'comfyui-video';
}

export async function POST(request: NextRequest) {
  let body: {
    llm?: { providerId?: string; modelId?: string };
    image?: ModalityInput;
    video?: ModalityInput;
    tts?: ModalityInput;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const checks: ReadinessCheck[] = [];

  // LLM is the one modality generation cannot proceed without; probe it when
  // the client knows its selection.
  if (body.llm?.providerId && body.llm?.modelId) {
    checks.push(await probeLlm(body.llm.providerId, body.llm.modelId));
  }

  for (const [label, input] of [
    ['image', body.image],
    ['video', body.video],
    ['tts', body.tts],
  ] as const) {
    if (!input?.enabled) continue;
    // A local server modality (ComfyUI, Kokoro, any self-hosted backend):
    // probe it - these are exactly the ones that die silently while the LLM
    // burns tokens.
    if (input.baseUrl) {
      const probePath = isComfy(input.providerId) ? '/system_stats' : '';
      const reachability = await probe(`${input.baseUrl.replace(/\/+$/, '')}${probePath}`);
      if (reachability === 'unreachable') {
        checks.push({
          key: label,
          status: 'unreachable',
          detail: `the ${label} server is not responding at ${input.baseUrl} - start it, or disable ${label} generation`,
        });
        continue;
      }
      if (reachability === 'auth_error') {
        checks.push({ key: label, status: 'auth_error', detail: `${label} server rejected the request` });
        continue;
      }
      if (isComfy(input.providerId) && input.modelSelected === false) {
        checks.push({
          key: label,
          status: 'unconfigured',
          detail: `ComfyUI is running, but no workflow/model has been selected yet`,
        });
        continue;
      }
      checks.push({ key: label, status: 'ready', detail: `server reachable at ${input.baseUrl}` });
      continue;
    }
    // API-backed modality (no self-hosted server): config presence only -
    // probing would burn quota.
    if (input.providerId) {
      checks.push({
        key: label,
        status: 'ready',
        detail: `${input.providerId} configured`,
      });
      continue;
    }
    checks.push({ key: label, status: 'unconfigured', detail: `${label} provider not set` });
  }

  return NextResponse.json({ checks });
}
