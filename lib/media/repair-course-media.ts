import { drainPendingSceneTTS } from '@/lib/hooks/use-scene-generator';
import { createLogger } from '@/lib/logger';
import type { Scene } from '@/lib/types/stage';

const log = createLogger('RepairCourseMedia');

/**
 * Bounded-repetition media repair wrapper ("same train" / class-agnostic
 * decay handling).
 *
 * The canonical repair primitive is `drainPendingSceneTTS` — it re-synthesizes
 * narration under the persisted speech-action references, updates the stored
 * scene (so the audioId sticks), and preserves working audio when a pass
 * fails (no stripping-healthy-audio side effects). This wrapper adds what a
 * single pass cannot give: TTS providers flake nondeterministically (Kokoro's
 * "input lines" split, overload refreshes), so repair runs in a small number
 * of passes with idempotent detection — a clip that resolves is never
 * touched, so repeated passes cost nothing on the success path.
 *
 * Scope note (class coverage): audio references resolve through the player's
 * own path (pool → audioFiles mirror), so "no audioId / unplayable bytes" is
 * exactly what repair detects. Image/video byte-level repair needs its own
 * generation contracts (media orchestrator already re-kicks unreplaced
 * placeholders on resume); that gener a lization lands with the orchestrator's
 * byte-aware skip predicate — this module covers the audio class fully.
 */

export interface MediaRepairReport {
  /** Scenes whose narration was restored (bytes present again). */
  audioRestored: number;
  /** Scenes that still had audio pending after the last pass. */
  audioStillPending: number;
  passes: number;
}

export interface MediaRepairOptions {
  /** Repair passes (default 2 — TTS providers flake nondeterministically). */
  passes?: number;
  language?: string;
  signal?: AbortSignal;
}

export async function repairCourseMedia(
  scenes: Scene[],
  options: MediaRepairOptions = {},
): Promise<MediaRepairReport> {
  const passes = Math.max(1, Math.min(4, options.passes ?? 2));
  const report: MediaRepairReport = { audioRestored: 0, audioStillPending: 0, passes };

  for (let pass = 0; pass < passes; pass += 1) {
    const restored = await drainPendingSceneTTS(scenes, options.language, options.signal);
    if (restored === 0) {
      log.info(`Media repair pass ${pass + 1}/${passes} restored nothing (nothing pending or provider unavailable); stopping`);
      break;
    }
    report.audioRestored += restored;
    if (pass < passes - 1) {
      log.warn(`Media repair pass ${pass + 1}/${passes} restored ${restored} scene(s); another pass — some clips likely still missing`);
    }
  }

  report.audioStillPending = scenes.filter((scene) =>
    (scene.actions ?? []).some(
      (action) => action.type === 'speech' && !!action.text && !action.audioId,
    ),
  ).length;

  log.info(
    `Media repair complete: ${report.audioRestored} scene(s) restored across ${report.passes} pass(es); ${report.audioStillPending} still pending`,
  );
  return report;
}
