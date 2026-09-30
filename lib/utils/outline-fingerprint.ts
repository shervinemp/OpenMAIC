/**
 * What a scene was generated FROM, at the plan level.
 *
 * A scene's content, narration, media and checks are all downstream of its
 * outline. `actionsSourceHash` covers content → actions, but not the outline
 * itself, so a plan that is regenerated or replanned under a scene that already
 * exists left every later step looking finished: the scene's phase rows stayed
 * `done` and a retry reused the old content because its own hash still
 * matched.
 *
 * The fingerprint is taken over the outline's substance only. These never
 * count as a change, because they move without the lesson changing:
 *  - `id` (identity), `order` and `lessonId` (renumbering on insert/reorder),
 *  - `title` (cosmetic; the slide carries its own),
 *  - `estimatedDuration`,
 *  - `retrievalContext` and `languageNote` (re-derived, non-deterministic text
 *    that differs on every run without the plan differing).
 * Everything else does, so a field added to the outline later is tangible by
 * default. Whitespace runs collapse, so a re-stream that only re-wraps text is
 * not a change.
 */
import type { SceneOutline } from '@/lib/types/generation';
import { fingerprintPayload, stableStringify } from '@/lib/utils/content-hash';

const OUTLINE_HASH_SALT = 'openmaic:outline-source:v1';

const NON_SUBSTANTIVE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'order',
  'lessonId',
  'title',
  'estimatedDuration',
  'retrievalContext',
  'languageNote',
]);

function normalize(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[key] = normalize(entry);
    }
    return out;
  }
  return value;
}

export function outlineFingerprint(outline: SceneOutline): string {
  const substance: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(outline as unknown as Record<string, unknown>)) {
    if (NON_SUBSTANTIVE_KEYS.has(key) || entry === undefined) continue;
    substance[key] = normalize(entry);
  }
  return fingerprintPayload(`${OUTLINE_HASH_SALT}\u0000${stableStringify(substance)}`);
}
