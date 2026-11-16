/**
 * Provider budgets - the abstraction the queue-storm fixes (single-flight,
 * bounded dispatch, cheap-first ordering) derive from, instead of tuning
 * ComfyUI by name.
 *
 * Each provider class declares:
 *   concurrency    logical max in-flight (the orchestrator's serial loop is
 *                  per-provider already; the budget documents the ceiling
 *                  and gates future parallel dispatchers)
 *   generationCap  per-pass cap on the FIRST generation pass. Without it a
 *                  semester-sized deck buys every outline-declared image and
 *                  video in one click; the remainder waits for a later pass.
 *   requeueCap     per-pass cap on the mount-time repair/requeue pass (a huge
 *                  backlog waits for the next pass rather than stacking the
 *                  backend queue behind duplicates)
 *   costWeight     relative cost of one job - the dispatch orders cheap jobs
 *                  first so a single heavy item can not head-of-line-block
 *                  the cheap backlog behind a 1800s queue-wait kill
 *
 * Environment overrides (build-time, because the orchestrator runs in the
 * browser):
 *   NEXT_PUBLIC_COURSE_MEDIA_IMAGE_GENERATION_LIMIT
 *   NEXT_PUBLIC_COURSE_MEDIA_VIDEO_GENERATION_LIMIT
 *   NEXT_PUBLIC_COURSE_MEDIA_IMAGE_REQUEUE_LIMIT
 *   NEXT_PUBLIC_COURSE_MEDIA_VIDEO_REQUEUE_LIMIT
 * The unprefixed names still apply in server/test contexts. Values are static
 * table defaults - a configurable knob without a config system, read once per
 * pass.
 */

export interface ProviderBudget {
  readonly generationCap: number;
  readonly requeueCap: number;
  readonly costWeight: number;
  readonly concurrency: number;
}

export interface MediaProviderBudgets {
  image: ProviderBudget;
  video: ProviderBudget;
  tts: ProviderBudget;
}

export interface MediaDispatchCaps {
  readonly image: number;
  readonly video: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw.trim()) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function mediaProviderBudgets(): MediaProviderBudgets {
  // Literal process.env.NEXT_PUBLIC_* references: Next inlines only these.
  const imageGenerationLimitRaw =
    process.env.NEXT_PUBLIC_COURSE_MEDIA_IMAGE_GENERATION_LIMIT ??
    process.env.COURSE_MEDIA_IMAGE_GENERATION_LIMIT;
  const videoGenerationLimitRaw =
    process.env.NEXT_PUBLIC_COURSE_MEDIA_VIDEO_GENERATION_LIMIT ??
    process.env.COURSE_MEDIA_VIDEO_GENERATION_LIMIT;
  const imageLimitRaw =
    process.env.NEXT_PUBLIC_COURSE_MEDIA_IMAGE_REQUEUE_LIMIT ??
    process.env.COURSE_MEDIA_IMAGE_REQUEUE_LIMIT;
  const videoLimitRaw =
    process.env.NEXT_PUBLIC_COURSE_MEDIA_VIDEO_REQUEUE_LIMIT ??
    process.env.COURSE_MEDIA_VIDEO_REQUEUE_LIMIT;
  return {
    image: {
      generationCap: positiveInt(imageGenerationLimitRaw, 40),
      requeueCap: positiveInt(imageLimitRaw, 40),
      costWeight: 1,
      concurrency: 2,
    },
    video: {
      generationCap: positiveInt(videoGenerationLimitRaw, 8),
      requeueCap: positiveInt(videoLimitRaw, 8),
      costWeight: 20,
      concurrency: 1,
    },
    tts: {
      // Narration repair is bounded by drainPendingSceneTTS passes, not by
      // this table; the value documents the provider ceiling only.
      generationCap: 48,
      requeueCap: 48,
      costWeight: 1,
      concurrency: 4,
    },
  };
}

/**
 * Apply a per-class cap while preserving the caller's order. The orchestrator
 * sorts cheap jobs first before calling this, so a capped pass spends on
 * images before it spends on video.
 */
export function takeWithinMediaCaps<T extends { readonly type: 'image' | 'video' }>(
  requests: readonly T[],
  caps: MediaDispatchCaps,
): T[] {
  const taken: Record<'image' | 'video', number> = { image: 0, video: 0 };
  const selected: T[] = [];
  for (const request of requests) {
    if (taken[request.type] >= caps[request.type]) continue;
    taken[request.type] += 1;
    selected.push(request);
  }
  return selected;
}
