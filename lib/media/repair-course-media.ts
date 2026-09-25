import { drainPendingSceneTTS } from '@/lib/hooks/use-scene-generator';
import { createLogger } from '@/lib/logger';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
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
  /** Narration refs still missing after the passes. */
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
  /** Scene ids whose narration was detected dead (pre-drain byte truth). */
  narrationFailedSceneIds: string[];
  /** Scene ids generated-media refs missing at detection. */
  mediaFailedSceneIds: string[];
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
   * ONE-QUEUE hydration hook (classroom supply): when detection finds a
   * scene's narration/media dead, the phase row is recorded FIRST so the red
   * regenerate card exists before the automatic dispatch — the repair
   * dispatch is a consumer of that queue, not a parallel system.
   */
  onScenePhaseFailure?: (sceneId: string, phase: 'tts' | 'media') => void;
  /**
   * ONE-QUEUE resolution hook (the symmetry the failure hook needs): when a
   * scene the dispatcher recorded failed now passes the post-repair byte
   * audit (every ref the player resolves), the phase row flips to done —
   * without this the failed state from a transient provider drop would
   * persist forever even though the bytes are back (the stale red card).
   */
  onScenePhaseResolved?: (sceneId: string, phase: 'tts' | 'media') => void;
  /**
   * Persisted failed phase rows, keyed by scene id (the ONE QUEUE's stored
   * truth). A row left over from an earlier decay whose bytes verify healthy
   * has no dispatcher to flip it in this run (the resolution hook above only
   * iterates scenes that had DEAD refs), so the red card would outlive its
   * fix across sessions. With this map the audit lifts those stale rows the
   * moment byte truth disproves them.
   */
  persistedFailedPhases?: ReadonlyMap<string, ReadonlySet<'tts' | 'media'>>;
}

/** Narration refs carry the pipeline's stable-request-id shape (see walker). */
export function isNarrationRef(ref: string): boolean {
  return isNarrationRefShape(ref);
}

/** Player-equivalent byte probe for ANY ref a scene references. */
function isNarrationRefLocal(ref: string): boolean {
  return isNarrationRefShape(ref);
}

/**
 * Local-first byte detection across a WHOLE set of refs: whichever refs are
 * unresolvable LOCALLY go to the batched server oracle in ONE chunked pass
 * (no per-ref round-trips). The local split is deterministic same-source
 * audio/media chains the player itself uses, so "local missing + server
 * missing" is exactly dead materialization.
 */
async function batchRefResolvesBytes(
  refs: readonly string[],
  stageId: string | undefined,
): Promise<Map<string, boolean>> {
  const { probeServerAssetPresence, probeLocalAssetPresence } = await import(
    '@/lib/media/asset-oracle'
  );
  const resolved = new Map<string, boolean>();
  const missingLocally: string[] = [];
  for (const ref of refs) {
    const presence = await probeLocalAssetPresence(ref, stageId);
    if (presence === true) {
      resolved.set(ref, true);
    } else {
      missingLocally.push(ref);
    }
  }
  if (missingLocally.length === 0) return resolved;
  // Narration refs missing locally go through the AUDIO chain's local
  // resolution with server fallback untouched — the oracle is authoritative
  // for the server half; narration falls back to the per-ref resolver (pool
  // leasing + server-seeding mirror) so a single fatal miss isn't
  // misdiagnosed when the pool metadata alone is stale.
  const narrationMisses = missingLocally.filter(isNarrationRefLocal);
  const nonNarrationMisses = missingLocally.filter((ref) => !isNarrationRefLocal(ref));
  // Bounded fan-out: narration resolution DOWNLOADS bytes (pool resolve →
  // server fetch → mirror seed), and an unbounded Promise.all over a whole
  // deck's misses stampedes the dev server and the browser's connection
  // pool — observed as hundreds of transient null resolutions, which then
  // read as "still dead" and (wrongly) leave stale failed phases in place.
  // Chunking keeps the pass fast without the self-inflicted failure mode.
  const NARRATION_RESOLVE_CONCURRENCY = 8;
  for (let i = 0; i < narrationMisses.length; i += NARRATION_RESOLVE_CONCURRENCY) {
    const chunk = narrationMisses.slice(i, i + NARRATION_RESOLVE_CONCURRENCY);
    await Promise.all(
      chunk.map(async (ref) => {
        resolved.set(ref, await refResolvesBytes(ref, stageId));
      }),
    );
  }
  const serverPresent = await probeServerAssetPresence(nonNarrationMisses);
  for (const ref of nonNarrationMisses) {
    resolved.set(ref, serverPresent.get(ref) === true);
  }
  return resolved;
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
    narrationFailedSceneIds: [],
    mediaFailedSceneIds: [],
  };
  // Detection-time phase writes (ONE QUEUE): the classroom supplies this so
  // dead-narration/media scenes enter the same failed queue with their
  // phase rows BEFORE the automatic dispatch renders any of the fixes.
  const recordScenePhaseFailure = options.onScenePhaseFailure;
  const recordScenePhaseResolved = options.onScenePhaseResolved;

  // ---- Detection sweep (pre-repair truth, per ref) ----
  // Renderer-visible refs only (src/audioId/audioRef/mediaRef/poster):
  // `elementId` is the orchestrator's task class, and probing it here would
  // double-count pending work the orchestrator's own byte-aware requeue
  // already owns. Extra material objects (stage whiteboards, exam assets…)
  // are probed with the same key set; they have NO outline task spec, so
  // their dead refs are honest unrecoverables.
  const deadNarrationRefs = new Set<string>();
  const deadMediaRefs = new Set<string>();
  // Per-scene dead-ref bookkeeping for the post-repair audit: a scene
  // recorded failed by the hydration hook must be re-audited SPECIFICALLY on
  // its own refs — the flat ref set alone cannot attribute resurrection.
  const deadNarrationByScene = new Map<string, Set<string>>();
  const deadMediaByScene = new Map<string, Set<string>>();
  // Scenes whose refs of a class ALL verify this run — the candidates for
  // lifting a stale persisted failure (see persistedFailedPhases).
  const healthyNarrationScenes = new Set<string>();
  const healthyMediaScenes = new Set<string>();
  const detectionTargets = [
    ...scenes,
    ...(options.additionalAssets ?? []),
  ] as unknown[];
  // Oracle batch: collect every ref ONCE, then resolve in a local-first +
  // single-batched-server pass (no per-ref round-trips). Scene attribution
  // happens per material over the resolved map.
  const resolvedByRef = await batchRefResolvesBytes(
    detectionTargets.flatMap((material) =>
      collectDocumentMediaRefs(material, { includeElementIdRefs: false }),
    ),
    options.stageId,
  );
  for (const material of detectionTargets) {
    const refs = collectDocumentMediaRefs(material, { includeElementIdRefs: false });
    const narratedRefs = refs.filter(isNarrationRef);
    const mediaRefs = refs.filter((ref) => !isNarrationRef(ref));
    // Declared BEFORE the bookkeeping closures below run: they attribute dead
    // refs per material, and a `const` declared after their call sites threw
    // a TDZ ReferenceError the moment any ref was actually dead — crashing
    // the whole repair before it could run.
    const scene = material as { id?: string };
    const narratedOk = narratedRefs.map((ref) => resolvedByRef.get(ref) === true);
    const mediaOk = mediaRefs.map((ref) => resolvedByRef.get(ref) === true);
    narratedRefs.forEach((ref, i) => {
      if (!narratedOk[i]) {
        deadNarrationRefs.add(ref);
        if (scene.id) {
          const set = deadNarrationByScene.get(scene.id) ?? new Set<string>();
          set.add(ref);
          deadNarrationByScene.set(scene.id, set);
        }
      }
    });
    mediaRefs.forEach((ref, i) => {
      if (!mediaOk[i]) {
        deadMediaRefs.add(ref);
        if (scene.id) {
          const set = deadMediaByScene.get(scene.id) ?? new Set<string>();
          set.add(ref);
          deadMediaByScene.set(scene.id, set);
        }
      }
    });
    // Per-scene byte truth for the ONE QUEUE hydration: a scene with dead
    // narration/media is byte-truth (the card basis), while extra materials
    // (stage, agents, exams) only contribute ref counts.
    if (options.additionalAssets?.includes(material)) continue;
    const sceneDeadNarration = narratedOk.some((ok) => !ok);
    const sceneDeadMedia = mediaOk.some((ok) => !ok);
    if (sceneDeadNarration && scene.id) {
      report.narrationFailedSceneIds.push(scene.id);
      recordScenePhaseFailure?.(scene.id, 'tts');
    }
    if (sceneDeadMedia && scene.id) {
      recordScenePhaseFailure?.(scene.id, 'media');
      report.mediaFailedSceneIds.push(scene.id);
    }
    if (scene.id) {
      // Zero refs of a class is "nothing to verify", not "healthy": lifting a
      // failed row needs positive byte evidence.
      if (narratedRefs.length > 0 && !sceneDeadNarration) healthyNarrationScenes.add(scene.id);
      if (mediaRefs.length > 0 && !sceneDeadMedia) healthyMediaScenes.add(scene.id);
    }
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
      await generateMediaForOutlines(dispatchOutlines, options.stageId!, options.signal, {
        repair: true,
      });
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
  const postAudit = await batchRefResolvesBytes([...deadNarrationRefs], options.stageId);
  const stillDead: string[] = [...deadNarrationRefs].filter(
    (ref) => postAudit.get(ref) !== true,
  );
  report.audioStillPending = stillDead.length;

  // ---- Post-repair resolution: flip phases back to done where every ref
  // of a scene the failure hook recorded now resolves. Media gets the same
  // audit after the orchestrator dispatch (queue consumers ran synchronously
  // through generateMediaForOutlines' requeue above).
  if (recordScenePhaseResolved) {
    for (const [sceneId, refs] of deadNarrationByScene) {
      if ([...refs].every((ref) => postAudit.get(ref) === true)) {
        recordScenePhaseResolved(sceneId, 'tts');
      }
    }
  }
  if (canDispatchMedia && deadMediaRefs.size > 0) {
    const mediaPostAudit = await batchRefResolvesBytes([...deadMediaRefs], options.stageId);
    if (recordScenePhaseResolved) {
      for (const [sceneId, refs] of deadMediaByScene) {
        if ([...refs].every((ref) => mediaPostAudit.get(ref) === true)) {
          recordScenePhaseResolved(sceneId, 'media');
        }
      }
    }
  }

  // ---- Stale-failure reconciliation ----
  // A phase row recorded failed by an earlier decay whose refs verify healthy
  // right now would keep its red card forever: the resolution hook above only
  // sees scenes that had dead refs THIS run. Byte truth is the predicate's
  // only input, so lifting is always allowed and never invents health.
  if (recordScenePhaseResolved && options.persistedFailedPhases) {
    let lifted = 0;
    for (const [sceneId, phases] of options.persistedFailedPhases) {
      if (phases.has('tts') && healthyNarrationScenes.has(sceneId)) {
        recordScenePhaseResolved(sceneId, 'tts');
        lifted += 1;
      }
      if (phases.has('media') && healthyMediaScenes.has(sceneId)) {
        recordScenePhaseResolved(sceneId, 'media');
        lifted += 1;
      }
    }
    if (lifted > 0) {
      log.info(
        `Reconciled ${lifted} stale failed phase row(s) against byte truth ` +
          `(${options.persistedFailedPhases.size} persisted failed scene(s) audited)`,
      );
    }
  }

  log.info(
    `Media repair complete: ${report.audioRestored} narration ref(s) restored across ` +
      `${report.narrationPassesRun} pass(es); ${report.mediaRequeued} image/video/poster ref(s) ` +
      `re-queued (${report.mediaUnrecoverable} without a task spec); ` +
      `${report.audioStillPending} narration ref(s) still pending`,
  );
  return report;
}
