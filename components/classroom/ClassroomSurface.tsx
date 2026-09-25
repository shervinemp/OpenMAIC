'use client';

/**
 * ClassroomSurface — the classroom, wherever it is mounted.
 *
 * This is the body `/classroom/[id]` has always had: the load pipeline, the
 * generation-resume policy and the `Stage` dispatch under `ThemeProvider` /
 * `MediaStageProvider`. It moved out of the route file for exactly one reason
 * — the Pro workspace's third pane hosts the REAL classroom, not a preview and
 * not an iframe, so both surfaces must run the same code rather than two
 * copies that drift.
 *
 * `variant` is only layout/load-context: `page` fills the viewport and treats
 * a course that cannot be found as terminal; `pane` fills its column and runs
 * a bounded availability probe because a newly linked course may be committed
 * shortly afterward. Neither host accepts conversation/session state. A
 * classroom's lifecycle is keyed only by its course id; document and manifest
 * data then converge in place as writers update them.
 *
 * The reference (live deployment) additionally runs non-owner visitor
 * hydration, a transport-persistence UI fence and a background uploader; all
 * three depend on server-side machinery this workspace does not have, so they
 * are dropped and the load follows the ordinary path
 * (`app/classroom/[id]/page.tsx`). The stage-meta sidecar is still consulted:
 * both variants gate generation on ownership, and the standalone page also
 * applies its viewer-specific edit access.
 */

import { Stage } from '@/components/stage';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { claimStageSceneLoadToken, isCurrentStageSceneLoadToken } from '@/lib/store/stage';
import { loadResumeImageMapping } from '@/lib/utils/image-storage';
import { indexScenesByOutline } from '@/lib/utils/outline-scene-match';
import {
  clearGenerationSessionForStage,
  loadGenerationParams,
} from '@/lib/utils/generation-session-store';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useSceneGenerator } from '@/lib/hooks/use-scene-generator';
import { useNarrationAdoption } from '@/lib/audio/use-narration-adoption';
import { createLogger } from '@/lib/logger';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { useI18n } from '@/lib/hooks/use-i18n';
import { FileQuestion, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import {
  applyClassroomStageAndScenes,
  defaultClassroomLoadDeps,
  runClassroomLoad,
} from '@/lib/classroom/load-classroom';
import {
  paneAvailabilityRetryDelay,
  resolveClassroomSurfaceView,
  shouldResumeClassroomGeneration,
} from '@/lib/classroom/progressive-load-policy';
import { useClassroomSession } from '@/lib/classroom/use-classroom-session';

const log = createLogger('Classroom');

type ClassroomLoadOutcome = 'loaded' | 'unavailable' | 'absent' | 'failed' | 'cancelled';
const LOAD_UNAVAILABLE_ERROR = 'load-unavailable';

// stage_link can become visible shortly before its document. Probe only that
// explicit availability gap, with a small bounded backoff; media conversion
// and ordinary failures never enter this schedule.
export function ClassroomSurface({
  classroomId,
  variant = 'page',
}: {
  readonly classroomId: string;
  readonly variant?: 'page' | 'pane';
}) {
  const { loadFromStorage } = useStageStore();
  const loadedClassroomId = useStageStore((s) => s.stage?.id ?? null);
  const { t } = useI18n();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadUnavailable, setLoadUnavailable] = useState(false);
  /**
   * The load resolved and no source has this course. A TERMINAL state, kept
   * separate from `error`: an error offers a retry, and there is nothing here
   * to retry.
   *
   * The copy it renders is deliberately the SAME whether the course was
   * deleted or never existed.
   */
  const [notFound, setNotFound] = useState(false);
  const generationStartedRef = useRef(false);
  const activeClassroomIdRef = useRef<string | null>(null);
  const loadEpochRef = useRef(0);

  const { generateRemaining, retrySingleOutline, stop } = useSceneGenerator({
    onComplete: () => {
      log.info('[Classroom] All scenes generated');
    },
  });

  const { mayGenerate, refreshOwnership } = useClassroomSession({
    classroomId,
    variant,
    stopGeneration: stop,
  });

  const loadClassroom = useCallback(
    async (isEffectCurrent: () => boolean): Promise<ClassroomLoadOutcome> => {
      const loadToken = claimStageSceneLoadToken();
      const isCurrent = () => isEffectCurrent() && isCurrentStageSceneLoadToken(loadToken);

      try {
        const loadResult = await runClassroomLoad({
          classroomId,
          loadToken,
          isCurrent,
          loadFromStorage,
          getCurrentStage: () => useStageStore.getState().stage,
          fetchClassroom: defaultClassroomLoadDeps.fetchClassroom,
          applyFallbackScenes: (args) =>
            defaultClassroomLoadDeps.applyFallbackScenes({
              ...args,
              isCurrent,
              applyStageAndScenes: applyClassroomStageAndScenes,
            }),
          loadRestoredMediaTasks: defaultClassroomLoadDeps.loadRestoredMediaTasks,
          applyRestoredMediaTasks: (restored) =>
            defaultClassroomLoadDeps.applyRestoredMediaTasks(restored, isCurrent),
          discardRestoredMediaTasks: defaultClassroomLoadDeps.discardRestoredMediaTasks,
          loadLegacyAgentFallbacks: defaultClassroomLoadDeps.loadLegacyAgentFallbacks,
          commitMigratedAgentConfigs: defaultClassroomLoadDeps.commitMigratedAgentConfigs,
          applyGeneratedAgents: defaultClassroomLoadDeps.applyGeneratedAgents,
          getSettings: () => useSettingsStore.getState(),
          getAgent: (id) => useAgentRegistry.getState().getAgent(id),
          restoreAgentSelection: defaultClassroomLoadDeps.restoreAgentSelection,
          setError,
          setLoading,
          log,
        });
        if (!isCurrent()) return 'cancelled';

        // Positive absence only: the course is gone, invalid, or never
        // existed. Other failures stay on the error/retry path so we never
        // claim "not found" without a positive answer (#1450).
        if (loadResult.outcome === 'absent') {
          if (variant === 'page') {
            setNotFound(true);
          }
          // Inside the workspace the pane treats a miss as the bounded
          // availability gap (stage_link can land before the document).
          return 'absent';
        }

        if (loadResult.outcome === 'unavailable') {
          if (variant === 'pane') {
            // Retry through the availability schedule; exhaustion lands on the
            // error card with Retry, not the not-found claim.
            return 'unavailable';
          }
          setLoadUnavailable(true);
          setError(LOAD_UNAVAILABLE_ERROR);
          setLoading(false);
          return 'failed';
        }

        if (loadResult.outcome === 'cancelled') return 'cancelled';
        if (loadResult.outcome === 'failed') return 'failed';

        // Defensive: a "ready" load that somehow left the wrong course in the
        // store still must not become not-found.
        if (useStageStore.getState().stage?.id !== classroomId) {
          if (variant === 'pane') return 'unavailable';
          setLoadUnavailable(true);
          setError(LOAD_UNAVAILABLE_ERROR);
          setLoading(false);
          return 'failed';
        }
        return 'loaded';
      } catch (error) {
        log.error('Failed to load classroom:', error);
        if (isCurrent()) {
          setLoadUnavailable(false);
          setError(error instanceof Error ? error.message : 'Failed to load classroom');
          setLoading(false);
        }
        return isCurrent() ? 'failed' : 'cancelled';
      }
    },
    [classroomId, loadFromStorage, variant],
  );

  const retryClassroom = useCallback(() => {
    const loadEpoch = loadEpochRef.current + 1;
    loadEpochRef.current = loadEpoch;
    const isCurrent = () =>
      activeClassroomIdRef.current === classroomId && loadEpochRef.current === loadEpoch;
    setError(null);
    setLoadUnavailable(false);
    setNotFound(false);
    setLoading(true);

    void loadClassroom(isCurrent).then((outcome) => {
      if (!isCurrent()) return;
      if (outcome === 'loaded') {
        refreshOwnership(isCurrent);
        return;
      }
      if (variant === 'pane' && (outcome === 'unavailable' || outcome === 'absent')) {
        setLoading(false);
        if (outcome === 'absent') {
          setNotFound(true);
        } else {
          setLoadUnavailable(true);
          setError(LOAD_UNAVAILABLE_ERROR);
        }
      }
    });
  }, [classroomId, loadClassroom, refreshOwnership, variant]);

  useEffect(() => {
    let cancelled = false;
    const loadEpoch = loadEpochRef.current + 1;
    loadEpochRef.current = loadEpoch;
    activeClassroomIdRef.current = classroomId;
    const isCurrent = () =>
      !cancelled &&
      activeClassroomIdRef.current === classroomId &&
      loadEpochRef.current === loadEpoch;

    // Reset loading state on course switch to unmount Stage during transition,
    // preventing stale data from syncing back to the new course
    /* eslint-disable react-hooks/set-state-in-effect -- Course switch must hide stale Stage before async load */
    setLoading(true);
    setError(null);
    setLoadUnavailable(false);
    setNotFound(false);
    /* eslint-enable react-hooks/set-state-in-effect */
    generationStartedRef.current = false;

    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let availabilityAttempt = 0;
    /** Last pane gap reason — exhaustion must not claim not-found after a load error. */
    let lastGap: 'absent' | 'unavailable' | null = null;

    // Asked only AFTER a document load succeeds, and again after every later
    // one, mirroring the page route. The load is what brings a course into the
    // server store the first time it is opened, so asking beforehand asks about
    // a course whose ownership row does not exist yet: the 404 that comes back
    // would lock its genuine author out of generation and of every retry
    // control for the rest of the mount. The gate stays closed until an answer
    // arrives, so asking again can only ever open it for someone entitled to it.
    const loadUntilAvailable = async () => {
      if (!isCurrent()) return;
      // A previous pane attempt may have observed a transient read failure.
      // Clear only its presentation before retrying; do not raise `loading`
      // again, so an already mounted classroom never flashes away.
      if (variant === 'pane') setError(null);
      const outcome = await loadClassroom(isCurrent);
      if (!isCurrent()) return;

      if (outcome === 'absent' || outcome === 'unavailable') {
        lastGap = outcome;
        if (variant === 'pane') {
          const delay = paneAvailabilityRetryDelay(availabilityAttempt);
          availabilityAttempt += 1;
          if (delay !== null) {
            retryTimer = setTimeout(loadUntilAvailable, delay);
            return;
          }
          setLoading(false);
          if (lastGap === 'unavailable') {
            setLoadUnavailable(true);
            setError(LOAD_UNAVAILABLE_ERROR);
          } else {
            setNotFound(true);
          }
          return;
        }
      }

      // The document is now loaded, so the sidecar has something to say about
      // this course. Absence and load failures must not establish ownership.
      if (outcome === 'loaded') {
        refreshOwnership(isCurrent);
      }
    };
    void loadUntilAvailable();

    // Cancel ongoing generation when classroomId changes or component unmounts
    return () => {
      cancelled = true;
      if (loadEpochRef.current === loadEpoch) {
        loadEpochRef.current += 1;
      }
      if (activeClassroomIdRef.current === classroomId) {
        activeClassroomIdRef.current = null;
      }
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [classroomId, loadClassroom, refreshOwnership, variant]);

  // Narration written before this application stored media server-side is a
  // derived key that only this browser can resolve. Both classroom surfaces
  // mount this, so a course opened through the workbench pane converges its
  // narration exactly as the standalone page does.
  useNarrationAdoption(classroomId, { ready: !loading && !error, mayGenerate });

  // Byte repair (narration + generated media) as ONE re-runnable routine: on
  // mount for a settled deck, again when the browser comes back online, and on
  // demand from the sidebar. Detection is player-equivalent ("does the ref
  // resolve right now"); repair dispatches per class — the TTS drain for
  // narration, the orchestrator's byte-aware requeue for image/video — and
  // byte truth hydrates phase rows on the SAME failed queue first, so red
  // cards exist before the fixes land. Each run is one capped pass (the
  // per-pass requeue caps are the spend guard), so a heavily decayed course
  // heals across runs, never through an unbounded loop.
  const mediaRepairAbortRef = useRef<AbortController | null>(null);
  const [courseRepairing, setCourseRepairing] = useState(false);
  const runCourseMediaRepair = useCallback(async (): Promise<void> => {
    if (mediaRepairAbortRef.current) return; // one run at a time
    const storeState = useStageStore.getState();
    const { stage, outlines } = storeState;
    if (!stage || stage.id !== classroomId || outlines.length === 0) return;
    // A running batch owns the providers; repair waits for it to settle.
    if (storeState.generationStatus === 'generating') return;
    const controller = new AbortController();
    mediaRepairAbortRef.current = controller;
    setCourseRepairing(true);
    const scenes = [...storeState.scenes];
    // Stale-failure reconciliation input: persisted failed phase rows keyed by
    // scene id (lessonGroups jobs are outline-keyed). The repair audit lifts
    // these the moment byte truth disproves them.
    const failedPhasesBySceneId = new Map<string, Set<'tts' | 'media'>>();
    const jobByOutlineId = new Map(
      storeState.lessonGroups.flatMap((group) =>
        (group.jobs ?? []).map((job) => [job.outlineId, job] as const),
      ),
    );
    for (const scene of scenes) {
      const job = scene.outlineId ? jobByOutlineId.get(scene.outlineId) : undefined;
      const phases = new Set<'tts' | 'media'>();
      if (job?.phases?.tts?.status === 'failed') phases.add('tts');
      if (job?.phases?.media?.status === 'failed') phases.add('media');
      if (phases.size > 0) failedPhasesBySceneId.set(scene.id, phases);
    }
    try {
      const { repairCourseMedia } = await import('@/lib/media/repair-course-media');
      await repairCourseMedia(scenes, {
        language: storeState.blueprint?.languageDirective,
        outlines,
        stageId: stage.id,
        signal: controller.signal,
        persistedFailedPhases: failedPhasesBySceneId,
        onScenePhaseFailure: (sceneId, phase) => {
          const scene = useStageStore.getState().scenes.find((s) => s.id === sceneId);
          if (!scene?.outlineId) return;
          useStageStore.getState().recordScenePhase(scene.outlineId, phase, {
            status: 'failed',
            error: phase === 'tts' ? 'Narration bytes missing' : 'Generated media bytes missing',
          });
          const outline = outlines.find((o) => o.id === scene.outlineId);
          if (outline) useStageStore.getState().addFailedOutline(outline);
        },
        // The failure hook's symmetry: when the repair dispatch restores
        // every ref a scene needs, the recorded failure must lift.
        onScenePhaseResolved: (sceneId, phase) => {
          const scene = useStageStore.getState().scenes.find((s) => s.id === sceneId);
          if (!scene?.outlineId) return;
          useStageStore.getState().recordScenePhase(scene.outlineId, phase, { status: 'done' });
          // The card the failure hook (or load hydration) raised drops with
          // its phase — unless a sibling phase is still failed.
          useStageStore.getState().settleFailedOutline(scene.outlineId);
        },
      });
    } catch (err) {
      if (!controller.signal.aborted) log.warn('[Classroom] Media repair error:', err);
    } finally {
      if (mediaRepairAbortRef.current === controller) mediaRepairAbortRef.current = null;
      setCourseRepairing(false);
    }
  }, [classroomId]);

  // Leaving the course (or switching to another) cancels a repair in flight:
  // its drain and requeue would otherwise keep calling providers for a course
  // nobody is looking at.
  useEffect(
    () => () => {
      mediaRepairAbortRef.current?.abort();
      mediaRepairAbortRef.current = null;
    },
    [classroomId],
  );

  // Reconnect: repairs that failed while the network was down get another
  // pass the moment it is back, instead of waiting for the next page open.
  useEffect(() => {
    if (loading || error || !mayGenerate) return;
    const onOnline = () => void runCourseMediaRepair();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [loading, error, mayGenerate, runCourseMediaRepair]);

  // Auto-resume generation for pending outlines (owner only). Two independent
  // ownership facts gate it. The sidecar's per-viewer answer decides whether
  // this browser may spend the operator's provider budget at all, and fails
  // closed while unanswered; `generationStartedRef` is deliberately NOT
  // latched while it refuses, so the effect starts once the answer arrives.
  // `outlineProducer` then decides whether the browser is the producer: a
  // course whose document a server job produced is server-owned, not
  // client-authored, and therefore not this browser's to regenerate. The
  // reference's transport-persistence UI fence has no counterpart here, so it
  // stays a constant false.
  useEffect(() => {
    if (
      !shouldResumeClassroomGeneration({
        loading,
        error,
        transportPersistenceFenced: false,
        generationStarted: generationStartedRef.current,
        mayGenerate,
      })
    ) {
      return;
    }
    const state = useStageStore.getState();
    // Producer ownership is document data, not conversation status. A
    // server-job course never starts a second browser-side generator no matter
    // which chat is open (or whether any chat is open).
    if (state.outlineProducer === 'server-job') {
      generationStartedRef.current = true;
      log.info('[Classroom] A server-side job owns this course; the browser will not generate.');
      return;
    }

    const { outlines, scenes, stage, generationComplete } = state;

    // Check if there are pending outlines. A finished deck is frozen for
    // editing: deleting a slide leaves its outline orphaned, but that must not
    // be treated as an interrupted generation and regenerated. Only resume
    // when generation has not completed. Skipped outlines are finalized
    // without a scene and are neither resumed nor counted.
    //
    // Queue semantics ("same train", reload-safe + lossless): the resume
    // queue is DERIVED from the persisted invariant — outline without a
    // scene — not from session memory. Previously-failed outlines re-enter
    // the same train automatically when NEXT_PUBLIC_AUTO_RETRY_FAILED_GENERATION
    // is on; otherwise they stay parked behind retry cards so the user decides
    // whether a provider-side failure is worth re-burning tokens.
    const materialized = indexScenesByOutline(scenes);
    const autoRetryFailed = ['1', 'true'].includes(
      (process.env.NEXT_PUBLIC_AUTO_RETRY_FAILED_GENERATION ?? '0').trim().toLowerCase(),
    );
    const failedIds = new Set(state.failedOutlines.map((o) => o.id));
    const skipIds = new Set(state.skippedOutlineIds);
    const outlineIsPending = (outline: { id: string; order: number }): boolean =>
      !materialized.has(outline) &&
      !skipIds.has(outline.id) &&
      !(failedIds.has(outline.id) && !autoRetryFailed);
    const hasPending = !generationComplete && outlines.some(outlineIsPending);

    if (hasPending && stage) {
      generationStartedRef.current = true;

      // Params persisted by generation-preview on the session record
      // (IndexedDB — see generation-session-store), looked up by the course
      // id so the resume works even without the sessionStorage envelope (tab
      // close, browser restart).
      void (async () => {
        const params = (await loadGenerationParams(classroomId)) ?? {};
        // Asset ids and IndexedDB copies merged (see loadResumeImageMapping).
        const imageMapping = await loadResumeImageMapping(params.pdfImages);
        generateRemaining(
          {
            pdfImages: params.pdfImages,
            imageMapping,
            stageInfo: {
              name: stage.name || '',
              description: stage.description,
              style: stage.style,
            },
            agents: params.agents,
            userProfile: params.userProfile,
            languageDirective: params.languageDirective || stage.languageDirective,
            taskEngineMode: stage.taskEngineMode,
          },
          // The same rule `hasPending` used: parked failures stay parked
          // unless auto-retry is opted into.
          { includeFailed: autoRetryFailed },
        );
        // The params record is deliberately kept: a resumed batch can still
        // pause again (provider failure, tab close) and a later resume needs
        // the same media mapping. The TTL sweep reclaims stale records once
        // the stage settles; clearing here would break the second resume.
      })();
    } else if (outlines.length > 0 && stage) {
      generationStartedRef.current = true;
      // The deck reached the classroom already fully materialized (e.g. a
      // single-slide course, or a deck whose last slide finished in
      // generation-preview), so generateRemaining's completion path never
      // ran. Record completion now so a later edit/delete is not treated as
      // an interrupted generation. No-op if already complete or not all
      // outlines have scenes.
      useStageStore.getState().markGenerationCompleteIfDone();
      // Nothing needs the generation session anymore — drop any record a
      // handoff left behind (single-slide course, refresh-after-completion).
      void clearGenerationSessionForStage(classroomId);
      // Media recovery (same-train semantics): a fully materialized deck
      // whose narration or image/video/poster bytes decayed gets an automatic
      // repair run per mount (see runCourseMediaRepair).
      void runCourseMediaRepair();
      // Layout truth rides the SAME on-load pipeline: one deterministic,
      // tokenless sweep per course per session clamps + move-restacks and
      // keeps the persisted debt ledger honest (write-offs included).
      void (async () => {
        const { repairCourseLayout } = await import('@/lib/maintenance/repair-course-layout');
        await repairCourseLayout(stage.id, [...useStageStore.getState().scenes]);
        // Split-terminal parts (and any other materially-present scene) get
        // their content fingerprint in the same session.
        const { stampCourseSceneHashes } = await import('@/lib/maintenance/stamp-scene-hashes');
        await stampCourseSceneHashes(stage.id);
      })();
    }
    // classroomId: the params lookup and session cleanup are keyed by it. A
    // change re-runs this effect, but `generationStartedRef` still guards the
    // one-shot resume.
  }, [loading, error, mayGenerate, generateRemaining, classroomId, runCourseMediaRepair]);

  // In-page resume after a provider-failure pause (quota exhaustion, flaky
  // free tier): re-kick the batch with the same handoff params the first
  // auto-resume used. The session record is kept around for exactly this.
  const handleResumeGeneration = useCallback(async () => {
    const stage = useStageStore.getState().stage;
    if (!stage) return;
    const params = (await loadGenerationParams(classroomId)) ?? {};
    // Same merge as the mount-time resume: dropping the asset-id half here
    // lost every server-backed vision image on an in-page resume.
    const imageMapping = await loadResumeImageMapping(params.pdfImages);
    generateRemaining({
      pdfImages: params.pdfImages,
      imageMapping,
      stageInfo: {
        name: stage.name || '',
        description: stage.description,
        style: stage.style,
      },
      agents: params.agents,
      userProfile: params.userProfile,
      languageDirective: params.languageDirective || stage.languageDirective,
      taskEngineMode: stage.taskEngineMode,
    });
  }, [classroomId, generateRemaining]);

  // Dev/self-host recovery affordances (console-invocable). The media backfill
  // uploads browser-owned narration/media bytes into the server asset store so
  // the course-git repo snapshot can carry them; needs an open course + dev
  // persistence token. Deliberately NOT a product UI surface: it is an
  // operator tool and must not be reachable on hosted production.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const runtime = window as typeof window & {
      __openmaicMediaBackfill?: (stageId: string) => Promise<unknown>;
      __openmaicStampSceneHashes?: () => Promise<unknown>;
      __openmaicVerifyCourse?: (options?: { repair?: boolean }) => Promise<unknown>;
    };
    runtime.__openmaicMediaBackfill = async () => {
      const { useStageStore } = await import('@/lib/store');
      const state = useStageStore.getState();
      const snapshot = state.stage
        ? { stage: state.stage, scenes: state.scenes, outline: state.blueprint }
        : null;
      if (!snapshot) throw new Error('no persisted document; open the course first');
      const { backfillCourseMedia } = await import('@/lib/media/backfill-course-media');
      return backfillCourseMedia(snapshot);
    };
    // Hash-stamp backfill: legacy scenes generated before the actions-source
    // fingerprint existed carry no actionsSourceHash, so every repair on them
    // re-pays the full content/actions LLM passes even for a voice-only gap.
    // This computes their fingerprint from the CURRENT persisted content under
    // the restored generation params and stamps them — the amortizes one full
    // pass per legacy scene permanently. Idempotent: stamped scenes are skipped.
    runtime.__openmaicStampSceneHashes = async () => {
      const { useStageStore } = await import('@/lib/store');
      const state = useStageStore.getState();
      if (!state.stage) throw new Error('no persisted document; open the course first');
      const { loadGenerationParams } = await import('@/lib/utils/generation-session-store');
      const restored = await loadGenerationParams(state.stage.id);
      const {
        agents,
        userProfile,
        languageDirective = state.stage.languageDirective,
      } = restored ?? {};
      const { computeActionsSourceHash } = await import('@/lib/utils/content-hash');
      let stamped = 0;
      const scenes = state.scenes.map((scene) => {
        if (scene.actionsSourceHash !== undefined) return scene;
        stamped += 1;
        return {
          ...scene,
          actionsSourceHash: computeActionsSourceHash({
            content: scene.content,
            agents,
            userProfile,
            languageDirective,
          }),
        };
      });
      if (stamped === 0) return { stamped: 0 };
      // Persisting goes through the store's own save pipeline (debounced
      // stage-storage flush → server PUT → git scheduler) — no manual write,
      // the same app-flow path any scene mutation takes.
      state.setScenes(stamped === state.scenes.length ? [...scenes] : scenes);
      return { stamped, total: state.scenes.length };
    };
    // Placement sweep: the deterministic layout probe over every slide scene of
    // the open course (overflow + text occlusion, geometry only — no LLM).
    // With `repair: true` it additionally pulls each hanging/capped element
    // back inside the canvas bounds, then lets the store's save pipeline flush
    // the same path any scene mutation uses.
    runtime.__openmaicVerifyCourse = async (options) => {
      const { useStageStore } = await import('@/lib/store');
      const { sweepCoursePlacement } = await import('@/lib/slides/placement-sweep');
      const state = useStageStore.getState();
      if (!state.stage) throw new Error('no persisted document; open the course first');
      const result = sweepCoursePlacement(state.scenes as never, options);
      if (options?.repair && result.elementsClamped > 0) {
        state.setScenes(result.scenes as never);
      }
      return {
        scenesChecked: result.scenesChecked,
        scenesFlagged: result.scenesFlagged,
        elementsClamped: result.elementsClamped,
        summary: result.summary,
      };
    };
    return () => {
      delete runtime.__openmaicMediaBackfill;
      delete runtime.__openmaicStampSceneHashes;
      delete runtime.__openmaicVerifyCourse;
    };
  }, []);

  const view = resolveClassroomSurfaceView({
    variant,
    loading,
    error,
    notFound,
    loadedClassroomId,
    classroomId,
  });

  return (
    <ThemeProvider>
      <MediaStageProvider value={classroomId}>
        <div
          className={
            variant === 'pane'
              ? // A flex CHILD of the pane's row box, so it has to claim both
                // axes explicitly: `h-full` alone leaves the width to shrink
                // to content, and the classroom chrome (which layers with
                // `absolute inset-0`) then has nothing to fill.
                'flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden'
              : 'h-screen flex flex-col overflow-hidden'
          }
        >
          {view === 'loading' ? (
            <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin" />
                <p>{t('common.loadingClassroom')}</p>
              </div>
            </div>
          ) : view === 'not-found' ? (
            // Checked BEFORE `error`, and it renders no retry: the sources have
            // all answered, and running the same lookups again cannot change
            // the answer. One message for "deleted" and for "never existed" —
            // see the state's declaration.
            <div
              className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900"
              data-testid="classroom-not-found"
            >
              <div className="flex flex-col items-center gap-3 text-center max-w-md px-6">
                <FileQuestion className="h-10 w-10 text-muted-foreground" />
                <p className="text-lg font-medium">{t('classroom.notFound')}</p>
                <p className="text-sm text-muted-foreground">{t('classroom.notFoundDesc')}</p>
                <Link
                  href="/"
                  className="mt-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                >
                  {t('classroom.backToHome')}
                </Link>
              </div>
            </div>
          ) : view === 'error' ? (
            <div
              className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900"
              data-testid="classroom-load-error"
            >
              <div className="text-center">
                <p className="text-destructive mb-4">
                  {loadUnavailable ? (
                    t('classroom.loadUnavailable')
                  ) : (
                    <>
                      {t('common.errorPrefix')}
                      {error}
                    </>
                  )}
                </p>
                {loadUnavailable ? (
                  <p className="mb-4 text-sm text-muted-foreground">
                    {t('classroom.loadUnavailableDesc')}
                  </p>
                ) : null}
                <button
                  onClick={retryClassroom}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                >
                  {t('common.retry')}
                </button>
              </div>
            </div>
          ) : (
            <Stage
              classroomId={classroomId}
              onRetryOutline={mayGenerate ? retrySingleOutline : undefined}
              onResumeGeneration={mayGenerate ? handleResumeGeneration : undefined}
              onRepairCourse={mayGenerate ? () => void runCourseMediaRepair() : undefined}
              courseRepairing={courseRepairing}
            />
          )}
        </div>
      </MediaStageProvider>
    </ThemeProvider>
  );
}
