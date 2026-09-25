/**
 * Deterministic hash inputs for the scene-actions reuse guard.
 *
 * The actions stage (overview → canvas actions + narration actions) is a
 * pure function of its inputs. A retry that regenerates IDENTICAL content
 * with identical action-relevant parameters does not need to pay for the
 * actions LLM pass (or the downstream TTS re-queue) again — the previously
 * assembled scene is still correct. We hash the exact inputs and compare
 * against `scene.actionsSourceHash` (an optional app-level scene field;
 * app write validation is relaxed, so the field round-trips).
 */

const ACTIONS_HASH_EPS = 'openmaic:actions-source:v1';

/** Deterministic JSON serialization: keys sorted at every level. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return `${JSON.stringify(value)}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export interface ActionsSourceInput {
  content: unknown;
  agents?: unknown;
  userProfile?: unknown;
  languageDirective?: unknown;
}

/** Compute the reusable-actions fingerprint for one content+params attempt. */
export function computeActionsSourceHash(input: ActionsSourceInput): string {
  const payload = `${ACTIONS_HASH_EPS}\u0000${stableStringify(input)}`;
  // FNV-1a 32-bit + payload length: collision-safe enough for equality-guard
  // reuse (worst case a skipped actions pass that is still content-correct),
  // with no async crypto and no node-only imports.
  let h1 = 0x811c9dc5;
  let h2 = 0x011c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    const byte = payload.charCodeAt(i);
    h1 ^= byte;
    h1 = Math.imul(h1, 0x01000193);
    h2 = (h2 + i) ^ Math.imul(h2 ^ byte, 0x0001f123);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0') +
    `:${payload.length}`
  );
}
