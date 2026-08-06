'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { exportFullBackup, restoreFullBackup, type RestoreMode } from './full-backup';
import {
  captureSnapshot,
  getBackupPrefs,
  getSnapshots,
  removeSnapshot,
  restoreFromSnapshot as restoreSnapshot,
  setBackupPrefs,
} from './snapshots';
import type { BackupSnapshotMeta } from './snapshot-store';

const log = createLogger('UseFullBackup');

function summarize(
  result: {
    restored: number;
    replaced: number;
    skipped?: number;
    failed?: number;
  },
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const parts = [
    result.restored > 0 ? t('backup.countRestored', { count: result.restored }) : undefined,
    result.replaced > 0 ? t('backup.countReplaced', { count: result.replaced }) : undefined,
    result.skipped && result.skipped > 0
      ? t('backup.countSkipped', { count: result.skipped })
      : undefined,
    result.failed && result.failed > 0
      ? t('backup.countFailed', { count: result.failed })
      : undefined,
  ].filter(Boolean);
  return parts.join(', ');
}

export interface UseFullBackupOptions {
  /**
   * Load + watch the local snapshot list on mount. The Settings card needs
   * this; low-cost affordances such as the home-page restore button should
   * pass `false` so opening the app never scans IndexedDB for no reason.
   */
  withSnapshots?: boolean;
}

export function useFullBackup(options: UseFullBackupOptions = {}) {
  const { withSnapshots = true } = options;
  const { t } = useI18n();
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [autoSnapshots, setAutoSnapshots] = useState(false);
  const [snapshots, setSnapshots] = useState<BackupSnapshotMeta[]>([]);

  const refresh = useCallback(async () => {
    try {
      setSnapshots(await getSnapshots());
      setAutoSnapshots((await getBackupPrefs()).autoSnapshots);
    } catch (error) {
      log.warn('Could not load backup state:', error);
    }
  }, []);

  useEffect(() => {
    if (!withSnapshots) return;
    void refresh();
  }, [refresh, withSnapshots]);

  const handleExportAll = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setProgress(null);
    const toastId = toast.loading(t('backup.expPreparing'));
    try {
      const result = await exportFullBackup((index, total, name) => {
        setProgress(t('backup.progressPack', { index, total, name }));
      });
      toast.success(
        t('backup.expDone', {
          courses: t('backup.coursesOther', { count: result.courses }),
          settings: result.settingsIncluded ? t('backup.settingsSuffix') : '',
        }),
        { id: toastId },
      );
    } catch (error) {
      log.error('Full backup export failed:', error);
      toast.error(t('backup.expFailed'), { id: toastId });
    } finally {
      setExporting(false);
      setProgress(null);
    }
  }, [exporting, t]);

  const handleRestoreFile = useCallback(
    async (file: File, mode: RestoreMode = 'replace') => {
      if (restoring) return;
      setRestoring(true);
      setProgress(null);
      const toastId = toast.loading(t('backup.resPreparing'));
      try {
        const result = await restoreFullBackup(file, {
          mode,
          onCourse: (label, phase) =>
            setProgress(
              phase === 'replacing'
                ? t('backup.progressReplace', { name: label })
                : phase === 'skipping'
                  ? t('backup.progressSkip', { name: label })
                  : t('backup.progressRestore', { name: label }),
            ),
        });
        const summary = summarize(
          {
            restored: result.restored,
            replaced: result.replaced,
            skipped: result.skipped,
            failed: result.failed,
          },
          t,
        );
        toast.success(`${summary}${result.settingsRestored ? t('backup.settingsSuffix') : ''}`, {
          id: toastId,
        });
        // Settings and the classroom list live in browser stores; rehydrate them.
        window.location.reload();
      } catch (error) {
        log.error('Full backup restore failed:', error);
        toast.error(
          t('backup.resFailed', { message: error instanceof Error ? error.message : '' }),
          {
            id: toastId,
          },
        );
      } finally {
        setRestoring(false);
        setProgress(null);
      }
    },
    [restoring, t],
  );

  const handleToggleAuto = useCallback(
    async (enabled: boolean) => {
      setAutoSnapshots(enabled);
      await setBackupPrefs({ autoSnapshots: enabled });
      toast.success(enabled ? t('backup.toggleOn') : t('backup.toggleOff'));
      if (enabled) {
        await captureSnapshot('manual enable');
        await refresh();
      }
    },
    [refresh, t],
  );

  const handleRestoreSnapshot = useCallback(
    async (id: string, mode: RestoreMode) => {
      const snapshot = snapshots.find((entry) => entry.id === id);
      if (!snapshot) return;
      if (restoring) return;
      setRestoring(true);
      const toastId = toast.loading(t('backup.snapPreparing'));
      try {
        const result = await restoreSnapshot(snapshot, mode, (label) =>
          setProgress(t('backup.progressRestore', { name: label })),
        );
        toast.success(
          summarize(
            { restored: result.restored, replaced: result.replaced, failed: result.failed },
            t,
          ),
          { id: toastId },
        );
        window.location.reload();
      } catch (error) {
        log.error('Snapshot restore failed:', error);
        toast.error(
          t('backup.resFailed', { message: error instanceof Error ? error.message : '' }),
          {
            id: toastId,
          },
        );
      } finally {
        setRestoring(false);
        setProgress(null);
      }
    },
    [restoring, snapshots, t],
  );

  const handleDeleteSnapshot = useCallback(
    async (id: string) => {
      try {
        await removeSnapshot(id);
        await refresh();
        toast.success(t('backup.snapDeleteDone'));
      } catch (error) {
        log.error('Snapshot delete failed:', error);
        toast.error(t('backup.snapDeleteFailed'));
      }
    },
    [refresh, t],
  );

  const handleCaptureNow = useCallback(async () => {
    setProgress(t('backup.capturing'));
    try {
      const snapshot = await captureSnapshot('manual');
      if (snapshot) {
        toast.success(
          t('backup.snapCaptured', {
            courses: t('backup.coursesOther', { count: snapshot.courseCount }),
            size: (snapshot.size / 1024 / 1024).toFixed(1),
          }),
        );
      } else {
        toast.error(t('backup.snapCaptureFailed'));
      }
      await refresh();
    } finally {
      setProgress(null);
    }
  }, [refresh, t]);

  return {
    exporting,
    restoring,
    progress,
    autoSnapshots,
    snapshots,
    exportFullBackup: handleExportAll,
    restoreFullBackup: handleRestoreFile,
    toggleAutoSnapshots: handleToggleAuto,
    captureSnapshot: handleCaptureNow,
    restoreSnapshot: handleRestoreSnapshot,
    deleteSnapshot: handleDeleteSnapshot,
    refreshSnapshots: refresh,
  };
}
