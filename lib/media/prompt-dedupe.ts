/**
 * Group generated-media requests that ask for the same bytes.
 *
 * The outline model works one scene at a time, so it routinely re-describes
 * the same diagram in two scenes ("a labelled diagram of the water cycle…").
 * Every request carries its own element id because each one fills a different
 * slide slot, so generating them independently calls the provider once per
 * slot and pays twice for the same image or clip.
 *
 * The grouping key is what determines the output: media type, normalized
 * prompt, aspect ratio and style. Order is preserved; a group's first request
 * is its leader — the one that buys — and the rest ride its bytes. A blank
 * prompt is never merged, because an empty request says nothing about the
 * bytes it wants.
 *
 * Pure and transport-free: the browser orchestrator and the server classroom
 * path share this definition.
 */

import type { MediaGenerationRequest } from '@/lib/media/types';

type DedupeKeyInput = Pick<MediaGenerationRequest, 'type' | 'prompt' | 'aspectRatio' | 'style'>;

export interface MediaRequestGroup<T extends DedupeKeyInput> {
  readonly leader: T;
  readonly duplicates: readonly T[];
}

/** Prompt equality is case- and whitespace-insensitive, not punctuation-blind. */
export function normalizeMediaPrompt(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The identity of one provider purchase, or null when the request is too
 * underspecified to claim another request's bytes.
 */
export function mediaPromptKey(request: DedupeKeyInput): string | null {
  const prompt = normalizeMediaPrompt(request.prompt);
  if (!prompt) return null;
  const style = request.style ? normalizeMediaPrompt(request.style) : '';
  return [request.type, prompt, request.aspectRatio ?? '', style].join('\u0000');
}

export function groupIdenticalMediaRequests<T extends DedupeKeyInput>(
  requests: readonly T[],
): MediaRequestGroup<T>[] {
  const groups: MediaRequestGroup<T>[] = [];
  const byKey = new Map<string, { leader: T; duplicates: T[] }>();

  for (const request of requests) {
    const key = mediaPromptKey(request);
    if (key === null) {
      groups.push({ leader: request, duplicates: [] });
      continue;
    }
    const existing = byKey.get(key);
    if (existing) {
      existing.duplicates.push(request);
      continue;
    }
    const group = { leader: request, duplicates: [] as T[] };
    byKey.set(key, group);
    groups.push(group);
  }

  return groups;
}
