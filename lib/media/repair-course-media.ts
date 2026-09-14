import { drainPendingSceneTTS } from '@/lib/hooks/use-scene-generator';
import { createLogger } from '@/lib/logger';
import {
  generateMediaForOutlines,
} from '@/lib/media/media-orchestrator';
import type { RepairProgressReporter } from '@/lib/store/repair-progress';
import { resolveAudioBlob } from '@/lib/media/resolve-audio-bytes';
import { resolveStoredBytes } from '@/lib/media/resolve-stored-bytes';
import {
  collectDocumentMediaRefs,
  isNarrationRefShape,
} from '@/lib/media/document-media-refs';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { MediaGenerationRequest } from '@/lib/media/types';

const log = createLogger('RepairCourseMedia');

/**
 * Class-agnostic media repair ("same train").
 *
 * One principle, every class: a ref is PENDING iff the bytes it would be
 * played with do not resolve right now, through the player's own resolution
 * order — never a narrower per-class proxy:
 *
 *   - Narration refs (`tts_*`/`audio_*`/`speech_*` ids carried by speech
 *     actions, plus any `/assets/` or pool ref a speech action cites):
 *     {@link resolveAudioBlob} — pool → `audioFiles` mirror → server asset
 *     store. Exactly what playback resolves, so "audio-pending" decks (ids
 *     persisted, bytes never materialized) are detected, not mistaken for
 *     done.
  *   - Every other kind of asset/material the course references — element
 *     images, videos and their mediaRef/poster refs, cover assets,
 *     whiteboard/cover surfaces, agent avatars, anything with bytes the
 *     renderer resolves (the opaque walk over `src`/`audioRef`/`mediaRef`/
 *     `poster` keys plus any extra material objects the caller passes):
 *     {@link resolveStoredBytes} — pool → Dexie compatibility row → task
 *     URL: the chain every export surface already trusts, with an
 *     export-grade policy (error pages and empty bodies are as dead as
 *     "no bytes").
 *
 * What is NOT byte repair: the document's own texts, outlines, speech texts,
 * agents, blueprint, exams, chats and media task metadata (statuses,
 * prompts, aspect ratios, voice bindings, videoManifest) are persisted JSON,
 * not bytes — they never decay out from under a working deck. Their
 * integrity is enforced by the store's load-time recovery invariant
 * (missing-outline fold-in) and the course-git snapshot; when the whole
 * document row is gone, reimporting the snapshot is the recovery path, and
 * byte repair is meaningless until then.
 *
 * Repair dispatches per class:
 *   - Narration: bounded passes of {@link drainPendingSceneTTS} — byte-aware
 *     per-clip regeneration; resolving clips are never paid for or
 *     orphaned, and a partial provider failure keeps every recovered clip.
 *   - Image/video: {@link generateMediaForOutlines}' byte-aware requeue — a
 *     done-marked task whose persisted row lost its bytes re-kicks under the
 *     SAME elementId; deterministic terminal failures stay settled. Orphaned
 *     outlines (user deleted the slide) are excluded from dispatch: their
 *     media would be paid generation for a slide that will not render.
 *
 * Refs that resolve nowhere AND have no regenerable task spec are reported
 * honestly (`mediaUnrecoverable`) instead of being silently dropped.
 */

export interface MediaRepairReport {
  /** Narration refs restored (bytes resolve again). */
  audioRestored: number;
  /** Narration refs still without resolvable bytes after the passes. */
  audioStillPending: number;
  /** Non-narration refs found with missing bytes (detection truth, pre-dispatch). */
  mediaPending: number;
  /**
   * Subset of `mediaPending` handed to the orchestrator's byte-aware
   * requeue this run. Refs already mid-repair inside a running orchestrator
   * pass are not double-dispatched (task identity dedupes), and refs with no
   * task spec cannot be re-queued at all.
   */
  mediaRequeued: number;
  /** Non-narration refs with no regenerable task spec behind them. */
  mediaUnrecoverable: number;
  /** Narration repair passes actually run (≤ `passes`; stops on first no-op). */
  narrationPassesRun: number;
}

export interface MediaRepairOptions {
  /** Narration repair passes (default 2 — TTS providers flake nondeterministically). */
  passes?: number;
  language?: string;
  signal?: AbortSignal;
  /**
   * The deck's outlines + the stage id. Together they enable the image/video
   * dispatch path (the outlines' mediaGenerations carry the regenerable task
   * specs; the stage id scopes the byte-aware row probe and the compat row).
   * When omitted, non-narration decay is detected and reported but not
   * re-queued from here.
   */
  outlines?: SceneOutline[];
  stageId?: string;
  /**
   * Any other material objects the course owns whose refs must be probed —
   * the Stage row (its whiteboard surfaces carry media refs), agent
   * bundles, exams. Walked with the same renderer-visible key set; a dead
   * ref here cannot be regenerated from an outline task spec, so it counts
   * as `mediaUnrecoverable` when missing (detection truth, never silently
   * dropped).
   */
  additionalAssets?: unknown[];
  /**
   * Where repair visibility surfaces. The classroom mounts with the
   * repair-progress reporter, so every dispatched class shows one card with
   * live done/total; programmatic callers (tests, backfill->upload chains)
   * may pass nothing.
   */
  repairReporter?: RepairProgressReporter;
}

/** Narration refs carry the pipeline's stable-request-id shape (see walker). */
export function isNarrationRef(ref: string): boolean {
  return isNarrationRefShape(ref);
}

/** Player-equivalent byte probe for ANY ref a scene references. */
async function refResolvesBytes(ref: string, stageId: string | undefined): Promise<boolean> {
  try {
    if (isNarrationRef(ref)) {
      const blob = await resolveAudioBlob(ref);
      return !!blob && blob.size > 0;
    }
    const bytes = await resolveStoredBytes(ref, {
      stageId,
      loadCompatRow: true,
      taskUrlFallback: true,
      fetchPolicy: { requireOk: true, requireNonEmpty: true },
    });
    return !!bytes && bytes.size > 0;
  } catch {
    return false;
  }
}

export async function repairCourseMedia(
  scenes: Scene[],
  options: MediaRepairOptions = {},
): Promise<MediaRepairReport> {
  const passes = Math.max(1, Math.min(4, options.passes ?? 2));
  const report: MediaRepairReport = {
    audioRestored: 0,
    audioStillPending: 0,
    mediaPending: 0,
    mediaRequeued: 0,
    mediaUnrecoverable: 0,
    narrationPassesRun: 0,
  };

  // ---- Detection sweep (pre-repair truth, per ref) ----
  // Renderer-visible refs only (src/audioId/audioRef/mediaRef/poster):
  // `elementId` is the orchestrator's task class, and probing it here would
  // double-count pending work the orchestrator's own byte-aware requeue
  // already owns. Extra material objects (stage whiteboards, exam assets…)
  // are probed with the same key set; they have NO outline task spec, so
  // their dead refs are honest unrecoverables.
  const deadNarrationRefs = new Set<string>();
  const deadMediaRefs = new Set<string>();
  const detectionTargets = [
    ...scenes,
    ...(options.additionalAssets ?? []),
  ] as unknown[];
  for (const material of detectionTargets) {
    const refs = collectDocumentMediaRefs(material, { includeElementIdRefs: false });
    const narratedRefs = refs.filter(isNarrationRef);
    const mediaRefs = refs.filter((ref) => !isNarrationRef(ref));
    const narratedOk = await Promise.all(
      narratedRefs.map((ref) => refResolvesBytes(ref, options.stageId)),
    );
    const mediaOk = await Promise.all(mediaRefs.map((ref) => refResolvesBytes(ref, options.stageId)));
    narratedRefs.forEach((ref, i) => {
      if (!narratedOk[i]) deadNarrationRefs.add(ref);
    });
    mediaRefs.forEach((ref, i) => {
      if (!mediaOk[i]) deadMediaRefs.add(ref);
    });
  }
  report.mediaPending = deadMediaRefs.size;
  report.mediaRequeued = deadMediaRefs.size;

  // ---- Image/video dispatch: byte-aware orchestrator requeue ----
  const canDispatchMedia = !!(options.outlines && options.stageId);
  if (canDispatchMedia && deadMediaRefs.size > 0) {
    // An outline whose slide was deleted must not have its media paid for:
    // the scene will never render, so the ref is dead by design unless the
    // outline itself re-materializes.
    const materializedOrders = new Set(scenes.map((scene) => scene.order));
    const dispatchOutlines = options.outlines!.filter((outline) =>
      materializedOrders.has(outline.order),
    );
    try {
      await generateMediaForOutlines(
        dispatchOutlines,
        options.stageId!,
        options.signal,
        options.repairReporter,
      );
    } catch (err) {
      if (options.signal?.aborted) {
        report.audioStillPending = deadNarrationRefs.size;
        log.info('Media repair aborted during image/video dispatch');
        return report;
      }
      log.warn('Image/video repair queue error:', err);
    }
    // Refs with no mediaGenerations spec (cross-profile imports, pre-task
    // eras) cannot be regenerated from an outline — count them honestly.
    const taskElementIds = new Set(
      options.outlines!.flatMap(
        (outline) => outline.mediaGenerations?.map((mg: MediaGenerationRequest) => mg.elementId) ?? [],
      ),
    );
    let covered = 0;
    for (const ref of deadMediaRefs) {
      if (taskElementIds.has(ref)) covered += 1;
    }
    report.mediaUnrecoverable = report.mediaPending - covered;
  } else if (!canDispatchMedia && report.mediaPending > 0) {
    // Nothing dispatchable was configured: everything missing is
    // unrecoverable from this call — still reported, never dropped.
    report.mediaUnrecoverable = report.mediaPending;
    report.mediaRequeued = 0;
  }

  // ---- Narration dispatch: bounded idempotent passes ----
  for (let pass = 0; pass < passes; pass += 1) {
    report.narrationPassesRun = pass + 1;
    const restored = await drainPendingSceneTTS(scenes, options.language, options.signal);
    if (restored === 0) break;
    report.audioRestored += restored;
  }

  // ---- Post-repair audit: which narration refs are STILL dead ----
  const stillDead: string[] = [];
  for (const ref of deadNarrationRefs) {
    if (!(await refResolvesBytes(ref, options.stageId))) stillDead.push(ref);
  }
  report.audioStillPending = stillDead.length;

  log.info(
    `Media repair complete: ${report.audioRestored} narration ref(s) restored across ` +
      `${report.narrationPassesRun} pass(es); ${report.mediaRequeued} image/video/poster ref(s) ` +
      `re-queued (${report.mediaUnrecoverable} without a task spec); ` +
      `${report.audioStillPending} narration ref(s) still pending`,
  );
  return report;
}
