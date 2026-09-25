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
 * Environment overrides (per class): `COURSE_MEDIA_REPAIR_REQUEUE_LIMIT`
 * (global), `COURSE_MEDIA_IMAGE_REQUEUE_LIMIT`, `COURSE_MEDIA_VIDEO_REQUEUE_LIMIT`.
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
  const globalLimitRaw = process.env.COURSE_MEDIA_REPAIR_REQUEUE_LIMIT;
  return {
    image: {
      requeueCap: positiveInt(process.env.COURSE_MEDIA_IMAGE_REQUEUE_LIMIT, 40),
      costWeight: 1,
      concurrency: 2,
    },
    video: {
      requeueCap: positiveInt(process.env.COURSE_MEDIA_VIDEO_REQUEUE_LIMIT, 8),
      costWeight: 20,
      concurrency: 1,
    },
    tts: {
      requeueCap: positiveInt(globalLimitRaw, 48),
      costWeight: 1,
      concurrency: 4,
    },
  };
}
