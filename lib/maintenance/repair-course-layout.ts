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

export async function repairCourseLayout(courseId: string): Promise<CourseLayoutRepairReport | null> {
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
    if (summary.residualDebt > 0) {
      log.warn(
        `${summary.residualDebt} slide(s) keep error-level occlusion after the lossless pass; ` +
          'see the layout-debt ledger (per-slide ruler or layout-status route) — ' +
          'regeneration there is an explicit choice',
      );
    }
    return summary;
  } catch {
    return null;
  }
}
