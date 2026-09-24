/**
 * Provider budgets — the abstraction the queue-storm fixes (single-flight,
 * bounded requeue, cheap-first ordering) derive from, instead of tuning
 * ComfyUI by name.
 *
 * Each provider class declares:
 *   concurrency   logical max in-flight (the orchestrator's serial loop is
 *                 per-provider already; the budget documents the ceiling
 *                 and gates future parallel dispatchers)
 *   requeueCap    per-pass cap on the mount-time requeue (a huge first
 *                 backlog waits for the next pass rather than stacking the
 *                 backend queue behind duplicates)
 *   costWeight    relative cost of one job — the dispatch orders cheap jobs
 *                 first so a single heavy item can not head-of-line-block
 *                 the cheap backlog behind a 1800s queue-wait kill
 *
 * Environment overrides: `NEXT_PUBLIC_COURSE_MEDIA_IMAGE_REQUEUE_LIMIT`,
 * `NEXT_PUBLIC_COURSE_MEDIA_VIDEO_REQUEUE_LIMIT` (build-time — the
 * orchestrator runs in the browser, where only NEXT_PUBLIC_* variables are
 * inlined; the unprefixed names still apply in server/test contexts).
 * Values are static table defaults — a configurable knob without a config
 * system, read once per pass.
 */

export interface ProviderBudget {
  readonly requeueCap: number;
  readonly costWeight: number;
  readonly concurrency: number;
}

export interface MediaProviderBudgets {
  image: ProviderBudget;
  video: ProviderBudget;
  tts: ProviderBudget;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw.trim()) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function mediaProviderBudgets(): MediaProviderBudgets {
  // Literal process.env.NEXT_PUBLIC_* references: Next inlines only these.
  const imageLimitRaw =
    process.env.NEXT_PUBLIC_COURSE_MEDIA_IMAGE_REQUEUE_LIMIT ??
    process.env.COURSE_MEDIA_IMAGE_REQUEUE_LIMIT;
  const videoLimitRaw =
    process.env.NEXT_PUBLIC_COURSE_MEDIA_VIDEO_REQUEUE_LIMIT ??
    process.env.COURSE_MEDIA_VIDEO_REQUEUE_LIMIT;
  return {
    image: {
      requeueCap: positiveInt(imageLimitRaw, 40),
      costWeight: 1,
      concurrency: 2,
    },
    video: {
      requeueCap: positiveInt(videoLimitRaw, 8),
      costWeight: 20,
      concurrency: 1,
    },
    tts: {
      // Narration repair is bounded by drainPendingSceneTTS passes, not by
      // this table; the value documents the provider ceiling only.
      requeueCap: 48,
      costWeight: 1,
      concurrency: 4,
    },
  };
}
