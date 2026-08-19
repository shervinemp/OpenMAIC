/**
 * In-memory TTS audio cache.
 *
 * TTS is the most expensive per-scene step and is purely deterministic for a
 * given (text, voice, provider, model, speed, options) tuple, so re-requesting
 * the same narration (scene retries, voice previews, repeated speech actions)
 * re-runs the provider for no reason. Cache the base64 result keyed by a hash
 * of that tuple; bounded LRU so a long course cannot grow it without limit.
 *
 * Process-local only: survives retries within a run, resets on server restart
 * (TTS is never persisted here — completed scenes already store their audio in
 * the stage store).
 */

import { createHash } from 'node:crypto';

interface TTSAudioCacheEntry {
  base64: string;
  format: string;
}

const MAX_ENTRIES = 500;
const cache = new Map<string, TTSAudioCacheEntry>();

export function ttsCacheKey(params: {
  text: string;
  providerId: string;
  modelId?: string;
  voice: string;
  speed: number;
  providerOptions?: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify([
    params.text,
    params.providerId,
    params.modelId ?? '',
    params.voice,
    params.speed,
    params.providerOptions ?? {},
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function getCachedTTS(key: string): TTSAudioCacheEntry | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  // LRU: re-insert to mark as most-recently-used.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

export function setCachedTTS(key: string, entry: TTSAudioCacheEntry): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}
