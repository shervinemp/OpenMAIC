import { createLogger } from '@/lib/logger';
import { readApiPayload } from '@/lib/utils/api-payload';

const log = createLogger('RepairCourseLayout');

/**
 * Deterministic layout-debt sweep — the lecture-truth sibling of
 * {@link repairCourseMedia}, running in the same on-load pipeline slot with
 * the same doctrine:
 *
 *   - Detection is always the placement validator (deterministic, zero
 *     tokens, zero false positives by design).
 *   - Repair starts lossless: out-of-bounds clamping plus pure move-only
 *     re-stacking. Content is never rewritten — the merge pass is the ONLY
 *     LLM in the path, delete-only (mergedDeleted ids are dropped rows),
 *     bounded by the server's 40-call cap, and only fires for rows a
 *     chunk truly cannot hold. Bounded spend, never a rewrite.
 *   - Phase truth rides the outline's job envelopes (unified red/green;
 *     lesson list serves scenes only when the layout phase is done).
 * A scene that still carries error-level occlusion after the lossless pass
 * lands on the split terminal (no manual gate; no red-cards, no
 * completion-gating).
 *
 * Sessions without the persistence token silently skip — repair on load is
 * best-effort, never a hard failure of course open.
 */
export interface CourseLayoutRepairReport {
  scanned: number;
  planned: number;
  writtenOff: number;
  residualDebt: number;
  /** Empty split-leftover parts pruned by this pass (delete-only cleanup). */
  pruned: number;
}

/** One repair per course per session; re-runs are redundant sweeps. */
const appliedCourses = new Set<string>();

/**
 * One structural-change reload per course per browser session. The deck
 * changed server-side (a split applied, empty parts pruned) and the loaded
 * store no longer matches what the document says — reload once so the user
 * sees the real deck. The sessionStorage flag guards against reload loops; it
 * is keyed by course, or the first course to reload in a session left every
 * later one showing its stale deck until a manual refresh.
 */
function reloadOnceForStructuralChange(courseId: string): void {
  if (typeof window === 'undefined') return;
  const key = `__openmaicSplitReloaded:${courseId}`;
  try {
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, String(Date.now()));
  } catch {
    // No session storage (private mode, blocked site data): without a loop
    // guard, do not reload at all.
    return;
  }
  window.setTimeout(() => window.location.reload(), 50);
}

interface SceneLike {
  id: string;
  type: string;
  content?: unknown;
}

export async function repairCourseLayout(
  courseId: string,
  scenes: SceneLike[] = [],
): Promise<CourseLayoutRepairReport | null> {
  if (!courseId || appliedCourses.has(courseId)) return null;
  appliedCourses.add(courseId);
  const { isBrowserPersistenceEnabled, getPersistenceRequestHeaders } =
    await import('@/lib/persistence/bootstrap');
  if (!isBrowserPersistenceEnabled()) {
    appliedCourses.delete(courseId);
    return null;
  }
  const headers = await getPersistenceRequestHeaders();
  try {
    const response = await fetch('/api/course-maintenance/layout-repair', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ courseId, dryRun: false, allowMerge: true }),
    });
    if (!response.ok) {
      log.warn('layout repair on load failed (non-fatal)', await response.text().catch(() => ''));
      return null;
    }
    const payload = readApiPayload<{
      scenesScanned?: number;
      scenesPlanned?: number;
      pruned?: number;
      skippedFresh?: number;
      reports?: Array<{ applied?: boolean; residualErrors?: number }>;
    }>(await response.json());
    const reports = payload?.reports ?? [];
    const summary: CourseLayoutRepairReport = {
      scanned: payload?.scenesScanned ?? 0,
      planned: payload?.scenesPlanned ?? 0,
      writtenOff: reports.filter((entry) => (entry.residualErrors ?? 0) === 0).length,
      residualDebt: reports.filter((entry) => (entry.residualErrors ?? 0) > 0).length,
      pruned: payload?.pruned ?? 0,
    };
    log.info(
      `layout repair on load: scanned=${summary.scanned} planned=${summary.planned} ` +
        `writtenOff=${summary.writtenOff} residualDebt=${summary.residualDebt} pruned=${summary.pruned}`,
    );
    // Empty parts were removed: the loaded store still holds them, so reload
    // once so the lesson list reflects the pruned deck.
    if (summary.pruned > 0) {
      reloadOnceForStructuralChange(courseId);
      return summary;
    }

    // Stage 2 (fill-decay class): scenes the deterministic pass could not
    // cure get one bounded layout-patch pass per session — content is reused
    // verbatim (zero content tokens), the patch respects the ±20% / exact-id
    // contract, and scenes it cannot fully cure simply stay on the ledger
    // (splitter / selective regeneration territory; never red-carded, never
    // completion-gating). The global repair budget cap inside the utility
    // bounds the whole pass.
    const sceneIdSet = new Set(scenes.map((s) => s.id));
    let patched = 0;
    let certified = 0;
    const touchedIds: string[] = [];
    if (scenes.length > 0) {
      const statusResponse = await fetch(
        `/api/course-maintenance/layout-status?courseId=${encodeURIComponent(courseId)}`,
        { headers },
      );
      if (statusResponse.ok) {
        const status = readApiPayload<{ flagged?: Array<{ sceneId: string }> }>(
          await statusResponse.json(),
        );
        const debtIds: string[] = [];
        for (const entry of status?.flagged ?? []) {
          if (sceneIdSet.has(entry.sceneId)) debtIds.push(entry.sceneId);
        }
        for (const sceneId of debtIds) {
          const scene = scenes.find((s) => s.id === sceneId);
          if (!scene) continue;
          const { verifyAndRepairSlideLayout } = await import('@/lib/slides/slide-layout-verify');
          const layout = await verifyAndRepairSlideLayout(scene.content);
          if (!layout.repaired && layout.clamped === 0) continue; // nothing changed
          patched += 1;
          touchedIds.push(sceneId);
          // ONE STATE MACHINE: the layout phase rides the outline's job
          // envelope (same ledger content/actions/tts/media read). Red cards
          // and the lesson-list serving rule draw from this — not a sidecar.
          const outlineId = (scene as unknown as { outlineId?: string }).outlineId;
          if (outlineId) {
            try {
              const { useStageStore } = await import('@/lib/store');
              useStageStore.getState().recordScenePhase(outlineId, 'layout', {
                status: layout.repairFailed ? 'failed' : 'done',
                error: layout.repairFailed
                  ? (layout.repairError ?? 'layout debt unresolved')
                  : undefined,
              });
            } catch {
              // Phase recording is best-effort; geometry truth still stands.
            }
          }
          if (!layout.repairFailed) {
            certified += 1;
            updateStoreScene(sceneId, layout.content);
          }
        }
        // Refresh the ledger for the scenes the fill pass changed (the
        // deterministic writer recomputes and stores their real status).
        if (patched > 0) {
          await fetch('/api/course-maintenance/layout-repair', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ courseId, sceneIds: [...touchedIds], dryRun: false }),
          }).catch(() => {});
        }
      }
    }
    summary.planned += patched;
    summary.writtenOff += certified;
    // Stage 3 (self-healing terminal): whatever STILL holds occlusion errors
    // after the lossless pass and the bounded patch pass gets split across
    // canvases — atomic saveDocument on the server, verbatim rows, anchored
    // action rides, one job envelope per part. Bounded LLM (allowMerge, the
    // 40-call delete-only reduntancy pruning, never a rewrite): still no
    // user gate — the splitter is exactly what keeps "a scene must fit or
    // it isn't here" an automatic doctrine.
    if (summary.residualDebt > 0) {
      const splitResponse = await fetch('/api/course-maintenance/split-apply', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ courseId }),
      }).catch(() => null);
      if (splitResponse?.ok) {
        const splitPayload = readApiPayload<{ applied?: number; scanned?: number }>(
          await splitResponse.json(),
        );
        log.info(
          `split apply on load: scanned=${splitPayload?.scanned ?? 0} applied=${splitPayload?.applied ?? 0}`,
        );
        // Applied>0 means the deck changed structurally: reload so the user
        // sees the SPLIT deck. Applied===0 with residual debt is a no-op pass
        // (_validator timing, an in-flight write, a declined cluster) — the
        // residual then survives the session by luck. Reload anyway (one-shot,
        // same flag): the next pass re-plans from fresh truth instead of a
        // session that ends with debt it could not close.
        const partCount = splitPayload?.applied ?? 0;
        if (partCount > 0) {
          summary.residualDebt = 0;
        } else {
          log.info(
            'split apply was a no-op; deferring residual to the next pass (one-shot reload)',
          );
        }
        reloadOnceForStructuralChange(courseId);
      } else {
        log.warn(
          'split apply on load failed (non-fatal)',
          await splitResponse?.text().catch(() => ''),
        );
      }
    }
    return summary;
  } catch {
    return null;
  }
}

function updateStoreScene(sceneId: string, content: unknown): void {
  void (async () => {
    const { useStageStore } = await import('@/lib/store');
    const state = useStageStore.getState();
    state.setScenes(
      state.scenes.map((entry) => (entry.id === sceneId ? { ...entry, content } : entry)) as never,
    );
  })();
}
