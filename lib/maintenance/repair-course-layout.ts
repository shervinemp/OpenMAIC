import { createLogger } from '@/lib/logger';

const log = createLogger('RepairCourseLayout');

/**
 * Deterministic layout-debt sweep — the lecture-truth sibling of
 * {@link repairCourseMedia}, running in the same on-load pipeline slot with
 * the same doctrine:
 *
 *   - Detection is always the placement validator (deterministic, zero
 *     tokens, zero false positives by design).
 *   - Repair is only the lossless class: out-of-bounds clamping plus pure
 *     move-only re-stacking. Content is never rewritten; the merge pass is
 *     not honored (allowMerge stays false) so load costs no LLM spend.
 *   - A scene that still carries error-level occlusion after the lossless
 *     pass lands on the persisted layout-debt ledger (`layoutStatus`). It is
 *     NOT pushed into `failedOutlines`: layout debt is not failed content,
 *     and red-carding it would gate a healthy deck behind legacy geometry
 *     and re-spend content tokens. Re-generation stays an explicit,
 *     per-slide choice; the ledger count surfaces how much is pending.
 *
 * Sessions without the persistence token silently skip — repair on load is
 * best-effort, never a hard failure of course open.
 */
export interface CourseLayoutRepairReport {
  scanned: number;
  planned: number;
  writtenOff: number;
  residualDebt: number;
}

/** One repair per course per session; re-runs are redundant sweeps. */
const appliedCourses = new Set<string>();

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
  const { isBrowserPersistenceEnabled, getPersistenceRequestHeaders } = await import(
    '@/lib/persistence/bootstrap'
  );
  if (!isBrowserPersistenceEnabled()) {
    appliedCourses.delete(courseId);
    return null;
  }
  const headers = await getPersistenceRequestHeaders();
  try {
    const response = await fetch('/api/course-maintenance/layout-repair', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ courseId, dryRun: false }),
    });
    if (!response.ok) {
      log.warn('layout repair on load failed (non-fatal)', await response.text().catch(() => ''));
      return null;
    }
    const payload = (await response.json()) as {
      data?: {
        scenesScanned?: number;
        scenesPlanned?: number;
        reports?: Array<{ applied?: boolean; residualErrors?: number }>;
      };
    };
    const reports = payload.data?.reports ?? [];
    const summary: CourseLayoutRepairReport = {
      scanned: payload.data?.scenesScanned ?? 0,
      planned: payload.data?.scenesPlanned ?? 0,
      writtenOff: reports.filter((entry) => (entry.residualErrors ?? 0) === 0).length,
      residualDebt: reports.filter((entry) => (entry.residualErrors ?? 0) > 0).length,
    };
    log.info(
      `layout repair on load: scanned=${summary.scanned} planned=${summary.planned} ` +
        `writtenOff=${summary.writtenOff} residualDebt=${summary.residualDebt}`,
    );

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
        const status = (await statusResponse.json()) as {
          data?: { flagged?: Array<{ sceneId: string }> };
        };
        const debtIds: string[] = [];
        for (const entry of status.data?.flagged ?? []) {
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
    if (summary.residualDebt > 0) {
      log.warn(
        `${summary.residualDebt} slide(s) keep error-level occlusion after the load pass; ` +
          'see the layout-debt ledger (per-slide ruler or layout-status route) — ' +
          'regeneration there is an explicit choice',
      );
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
