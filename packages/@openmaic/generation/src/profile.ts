/**
 * Generation profile (the overall cost/quality knob).
 *
 * `OPENMAIC_GENERATION_PROFILE` scales every quality/cost axis coherently so
 * operators tune one named value instead of six independent envs. Each axis
 * remains individually overridable (`OPENMAIC_DEPTH_FLOOR_SCALE`,
 * `OPENMAIC_CONTENT_ATTEMPTS`, `OPENMAIC_THINKING_PRESET`).
 *
 * - economy — validator floors scaled 0.75×, one corrective retry, `lean`
 *   thinking (validated-JSON stages skip CoT). Meaningful saving (~half of a
 *   semester run) at the cost of some prose density and fewer corrective
 *   reflections.
 * - balanced (default) — today's behavior, floors at 1×, two corrective
 *   retries, provider default thinking.
 * - premium — floors stay 1× (contracts, not an escalator), thinking freed to
 *   provider defaults; reserved for publish-grade runs.
 */

export type GenerationProfile = 'economy' | 'balanced' | 'premium';

export interface GenerationProfilePolicy {
  profile: GenerationProfile;
  depthFloorScale: number;
  contentAttempts: number;
  thinkingPreset: 'lean' | 'quality' | undefined;
}

const PROFILE_POLICY: Record<GenerationProfile, Omit<GenerationProfilePolicy, 'profile'>> = {
  economy: { depthFloorScale: 0.75, contentAttempts: 1, thinkingPreset: 'lean' },
  balanced: { depthFloorScale: 1, contentAttempts: 2, thinkingPreset: undefined },
  premium: { depthFloorScale: 1, contentAttempts: 2, thinkingPreset: undefined },
};

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const numeric = Math.round(Number(value));
  return Number.isFinite(numeric) && numeric >= 1 ? numeric : fallback;
}

function clampedScale(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(1.5, Math.max(0.5, numeric)) : fallback;
}

/**
 * Read once per call site (env is stable during a process lifetime, but tests
 * reset modules and re-assert affordably). Unknown profile values warn and
 * resolve to `balanced` rather than changing behavior silently.
 */
export function readGenerationProfile(env = process.env): GenerationProfilePolicy {
  const raw = env.OPENMAIC_GENERATION_PROFILE?.trim();
  const profile =
    raw === 'economy' || raw === 'premium'
      ? raw
      : 'balanced';
  const base = PROFILE_POLICY[profile];
  return {
    profile,
    depthFloorScale: clampedScale(env.OPENMAIC_DEPTH_FLOOR_SCALE, base.depthFloorScale),
    contentAttempts: positiveInt(env.OPENMAIC_CONTENT_ATTEMPTS, base.contentAttempts),
    thinkingPreset:
      (env.OPENMAIC_THINKING_PRESET?.trim() as GenerationProfilePolicy['thinkingPreset'] ?? undefined) ??
      base.thinkingPreset,
  };
}

/**
 * Scale a content-depth floor so the profile can loosen/tighten the contract
 * proportionally. Floors are integers; scale rounds toward the validator's
 * direction (a builder-promise), never below 1.
 */
export function scaleDepthFloor(value: number, scale: number): number {
  return Math.max(1, Math.round(value * scale));
}
