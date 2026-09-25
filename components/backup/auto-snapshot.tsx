'use client';

import { useEffect } from 'react';

import {
  captureAutomaticIfDue,
  getBackupPrefs,
  SNAPSHOT_INTERVAL_MS,
} from '@/lib/backup/snapshots';
import { createLogger } from '@/lib/logger';

const log = createLogger('AutoSnapshot');

/**
 * App-wide automatic snapshot driver. Mounted once in the root layout.
 *
 * Captures a local backup on a fixed cadence plus whenever the tab is hidden
 * (a good moment to coalesce work), but only while the "automatic local
 * snapshots" preference is enabled — the preference lives in the account KV
 * scope, not localStorage, so the flag and the data stay consistent.
 */
export function AutoSnapshot() {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const maybeCapture = async () => {
      if (cancelled) return;
      try {
        const prefs = await getBackupPrefs();
        if (!prefs.autoSnapshots) return;
        await captureAutomaticIfDue();
      } catch (error) {
        log.warn('Auto snapshot failed:', error);
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) void maybeCapture();
    };

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(() => {
        void maybeCapture().finally(schedule);
      }, SNAPSHOT_INTERVAL_MS);
    };

    // Fresh prefs each tick means toggling the setting takes effect without a reload.
    void maybeCapture();
    schedule();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handleVisibilityChange);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handleVisibilityChange);
    };
  }, []);

  return null;
}
