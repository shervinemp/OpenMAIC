import { NextRequest, NextResponse } from 'next/server';

import { TTS_PROVIDERS } from '@/lib/audio/constants';
import type { BuiltInTTSProviderId } from '@/lib/audio/types';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import {
  isServerConfiguredProvider,
  resolveApiKey,
  resolveBaseUrl,
  resolveImageBaseUrl,
  resolveVideoBaseUrl,
} from '@/lib/server/provider-config';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

/**
 * Generation readiness pre-flight.
 *
 * Answers one question before a course run starts: "will the enabled
 * modalities actually work?" A dead ComfyUI or TTS server otherwise only
 * surfaces after the LLM has burned tokens on outlines and scene content.
 *
 * Resolution parity is the invariant: every base URL / API key here is
 * resolved exactly the way the corresponding generate route resolves it
 * (server config > client value > registry default), so a `ready` check
 * means generation will genuinely use that endpoint. Each check carries a
 * server-decided `blocking` flag - the client only renders, it does not
 * re-interpret statuses. The whole gate is advisory; the user can proceed.
 */

export const runtime = 'nodejs';

type ReadinessKey = 'llm' | 'image' | 'video' | 'tts';
type ReadinessStatus = 'ready' | 'unreachable' | 'unconfigured' | 'auth_error';

interface ReadinessCheck {
  key: ReadinessKey;
  status: ReadinessStatus;
  blocking: boolean;
  detail?: string;
}

interface ModalityInput {
  enabled: boolean;
  providerId?: string;
  baseUrl?: string;
  /** For ComfyUI modalities: has any workflow/model been picked? */
  modelSelected?: boolean;
}

const blocking = (check: Omit<ReadinessCheck, 'blocking'>): ReadinessCheck => ({ ...check, blocking: true });

async function probe(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 4000,
): Promise<'reachable' | 'auth_error' | 'unreachable'> {
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

/** Rejects client-supplied base URLs exactly like the generate routes do. */
async function guardClientUrl(
  key: ReadinessKey,
  clientBaseUrl: string | undefined,
): Promise<ReadinessCheck | null> {
  if (!clientBaseUrl || process.env.NODE_ENV !== 'production') return null;
  const ssrfError = await validateUrlForSSRF(clientBaseUrl);
  if (ssrfError) {
    return blocking({
      key,
      status: 'unreachable',
      detail: ssrfError,
    });
  }
  return null;
}

async function checkLlm(input: {
  providerId?: string;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
}): Promise<ReadinessCheck | null> {
  const { providerId, modelId, apiKey, baseUrl } = input;
  // Mirrors generation: no resolvable provider+model means the run cannot
  // start at all (the home toolbar normally prevents this state).
  if (!providerId || !modelId) return null;
  const managed = isServerConfiguredProvider('providers', providerId);
  const clientBaseUrl = managed ? undefined : baseUrl || undefined;
  const guard = await guardClientUrl('llm', clientBaseUrl);
  if (guard) return guard;

  const effectiveKey = resolveApiKey(providerId, apiKey || '');
  const effectiveBaseUrl = resolveBaseUrl(providerId, clientBaseUrl);
  if (!effectiveBaseUrl) {
    if (effectiveKey) {
      return { key: 'llm', status: 'ready', blocking: false, detail: `${providerId} configured` };
    }
    return blocking({
      key: 'llm',
      status: 'unconfigured',
      detail: `no API key or base URL for ${providerId} - set it in settings or ${providerId.toUpperCase()}_API_KEY`,
    });
  }
  const reachability = await probe(`${effectiveBaseUrl.replace(/\/+$/, '')}/models`, {
    ...(effectiveKey ? { Authorization: `Bearer ${effectiveKey}` } : {}),
  });
  if (reachability === 'unreachable') {
    return blocking({
      key: 'llm',
      status: 'unreachable',
      detail: `${providerId} base URL did not respond (${effectiveBaseUrl})`,
    });
  }
  if (reachability === 'auth_error') {
    return blocking({
      key: 'llm',
      status: 'auth_error',
      detail: `${providerId} rejected the API key`,
    });
  }
  return { key: 'llm', status: 'ready', blocking: false, detail: `${providerId} reachable` };
}

function isComfyProvider(providerId: string): boolean {
  return providerId === 'comfyui-image' || providerId === 'comfyui-video';
}

/**
 * Local/self-hosted endpoints are the ones that die silently and are worth
 * an actual network probe. Public API endpoints are reported on config
 * presence only: probing them without the caller's key yields misleading
 * 401s, and their auth/quota failures already surface verbatim mid-run.
 */
function isLocalBaseUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname.endsWith('.local') ||
      /^127\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    );
  } catch {
    return false;
  }
}

async function checkImageOrVideo(
  key: 'image' | 'video',
  input: ModalityInput,
): Promise<ReadinessCheck | null> {
  if (!input.enabled) return null;
  const providerId = input.providerId;
  if (!providerId) {
    return blocking({ key, status: 'unconfigured', detail: `${key} provider not set` });
  }
  const section = key === 'image' ? 'image' : 'video';
  const managed = isServerConfiguredProvider(section, providerId);
  const clientBaseUrl = managed ? undefined : input.baseUrl || undefined;
  const guard = await guardClientUrl(key, clientBaseUrl);
  if (guard) return guard;

  // Same resolution chain as the generate routes: server config, else the
  // client value, else the provider registry default (e.g. ComfyUI's
  // http://localhost:8188, which the adapter applies at call time).
  const resolvedBaseUrl =
    (key === 'image'
      ? resolveImageBaseUrl(providerId, clientBaseUrl)
      : resolveVideoBaseUrl(providerId, clientBaseUrl)) ??
    (key === 'image'
      ? IMAGE_PROVIDERS[providerId as ImageProviderId]?.defaultBaseUrl
      : VIDEO_PROVIDERS[providerId as VideoProviderId]?.defaultBaseUrl);

  if (isComfyProvider(providerId) && input.modelSelected === false) {
    return blocking({
      key,
      status: 'unconfigured',
      detail: `no workflow/model selected yet - pick one in settings before generating`,
    });
  }
  if (resolvedBaseUrl && isLocalBaseUrl(resolvedBaseUrl)) {
    const probePath = isComfyProvider(providerId) ? '/system_stats' : '';
    const reachability = await probe(`${resolvedBaseUrl.replace(/\/+$/, '')}${probePath}`);
    if (reachability === 'unreachable') {
      return blocking({
        key,
        status: 'unreachable',
        detail: `the ${key} server is not responding at ${resolvedBaseUrl} - start it, or disable ${key} generation`,
      });
    }
    if (reachability === 'auth_error') {
      return blocking({ key, status: 'auth_error', detail: `the ${key} server rejected the request` });
    }
    return { key, status: 'ready', blocking: false, detail: `server reachable at ${resolvedBaseUrl}` };
  }
  return { key, status: 'ready', blocking: false, detail: `${providerId} configured` };
}

async function checkTts(input: ModalityInput): Promise<ReadinessCheck | null> {
  if (!input.enabled) return null;
  const providerId = input.providerId;
  if (!providerId) {
    return blocking({ key: 'tts', status: 'unconfigured', detail: 'tts provider not set' });
  }
  // TTS calls happen browser-side and the client applies the registry
  // default before sending; keep the same fallback here as a safety net.
  // Custom TTS providers are not in the registry - their baseUrl is
  // always stored in their config.
  const isBuiltInTts = (id: string): id is BuiltInTTSProviderId => id in TTS_PROVIDERS;
  const resolvedBaseUrl =
    input.baseUrl || (isBuiltInTts(providerId) ? TTS_PROVIDERS[providerId].defaultBaseUrl : '') || '';
  if (!resolvedBaseUrl) {
    // e.g. browser-native-tts: nothing to reach, always ready.
    return { key: 'tts', status: 'ready', blocking: false, detail: `${providerId}` };
  }
  if (isLocalBaseUrl(resolvedBaseUrl)) {
    const reachability = await probe(resolvedBaseUrl.replace(/\/+$/, ''));
    if (reachability === 'unreachable') {
      return blocking({
        key: 'tts',
        status: 'unreachable',
        detail: `the tts server is not responding at ${resolvedBaseUrl} - start it, or disable tts`,
      });
    }
    if (reachability === 'auth_error') {
      return blocking({ key: 'tts', status: 'auth_error', detail: 'the tts server rejected the request' });
    }
    return { key: 'tts', status: 'ready', blocking: false, detail: `server reachable at ${resolvedBaseUrl}` };
  }
  return { key: 'tts', status: 'ready', blocking: false, detail: `${providerId} configured` };
}

export async function POST(request: NextRequest) {
  let body: {
    llm?: { providerId?: string; modelId?: string; apiKey?: string; baseUrl?: string };
    image?: ModalityInput;
    video?: ModalityInput;
    tts?: ModalityInput;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const results = await Promise.all([
    checkLlm(body.llm ?? {}),
    checkImageOrVideo('image', body.image ?? { enabled: false }),
    checkImageOrVideo('video', body.video ?? { enabled: false }),
    checkTts(body.tts ?? { enabled: false }),
  ]);
  const checks = results.filter((check): check is ReadinessCheck => check !== null);

  return NextResponse.json({ checks });
}
