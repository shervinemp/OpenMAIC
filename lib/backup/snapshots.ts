/**
 * Automatic snapshot orchestration.
 *
 * Keeps up to {@link MAX_AUTO_SNAPSHOTS} full-backup copies inside IndexedDB.
 * Preferences (whether the feature is on) live in the account KV scope under
 * the `backup-preferences` key so the toggle persists between sessions.
 */
import { BrowserKVStore } from '@openmaic/storage';

import { createLogger } from '@/lib/logger';
import { buildFullBackupZip, restoreFullBackup, type RestoreMode } from './full-backup';
import {
  deleteSnapshot,
  getSnapshotBlob,
  listSnapshots,
  putSnapshot,
  type BackupSnapshotMeta,
} from './snapshot-store';

const log = createLogger('Snapshots');

const PREFS_KEY = 'backup-preferences';
const PREFS_SCOPE = 'account' as const;

export const PREF_CHANGE_EVENT = 'openmaic:backup-prefs-changed';
export const MAX_AUTO_SNAPSHOTS = 6;
export const SNAPSHOT_INTERVAL_MS = 30 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;

export interface BackupPrefs {
  autoSnapshots: boolean;
}

/** Coalescing key so background capture can't run more often than once per interval per tab. */
let lastAutomaticCapture = 0;

export async function getBackupPrefs(): Promise<BackupPrefs> {
  try {
    const prefs = await new BrowserKVStore().get<BackupPrefs>(PREFS_KEY, PREFS_SCOPE);
    return prefs ?? { autoSnapshots: false };
  } catch (error) {
    log.warn('Snapshots: could not read preferences:', error);
    return { autoSnapshots: false };
  }
}

export async function setBackupPrefs(prefs: BackupPrefs): Promise<void> {
  await new BrowserKVStore().set(PREFS_KEY, prefs, PREFS_SCOPE);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<BackupPrefs>(PREF_CHANGE_EVENT, { detail: prefs }));
  }
}

export async function captureSnapshot(label: string): Promise<BackupSnapshotMeta | null> {
  try {
    const { blob, manifest } = await buildFullBackupZip();
    if (blob.size > MAX_SNAPSHOT_BYTES) {
      log.warn(
        `Snapshot too large to keep locally (${(blob.size / 1024 / 1024).toFixed(0)}MB); skipped.`,
      );
      return null;
    }
    const snapshot: BackupSnapshotMeta = {
      id: manifest.exportedAt,
      savedAt: Date.parse(manifest.exportedAt),
      label,
      size: blob.size,
      courseCount: manifest.courseCount,
      settingsIncluded: manifest.settingsIncluded,
    };
    await putSnapshot(snapshot, blob);
    await pruneSnapshots();
    return snapshot;
  } catch (error) {
    log.error('Snapshots: capture failed:', error);
    return null;
  }
}

export async function captureAutomaticIfDue(): Promise<void> {
  const now = Date.now();
  if (now - lastAutomaticCapture < SNAPSHOT_INTERVAL_MS) return;
  const prefs = await getBackupPrefs();
  if (!prefs.autoSnapshots) return;
  lastAutomaticCapture = now;
  const snapshot = await captureSnapshot('automatic');
  if (snapshot) {
    log.info(
      `Automatic snapshot recorded: ${snapshot.courseCount} course(s), ${(snapshot.size / 1024 / 1024).toFixed(1)}MB`,
    );
  }
}

export async function pruneSnapshots(): Promise<void> {
  try {
    const snapshots = (await listSnapshots()).sort((a, b) => b.savedAt - a.savedAt);
    for (const snapshot of snapshots.slice(MAX_AUTO_SNAPSHOTS)) {
      await deleteSnapshot(snapshot.id);
    }
  } catch (error) {
    log.warn('Snapshots: prune failed:', error);
  }
}

export async function getSnapshots(): Promise<BackupSnapshotMeta[]> {
  return (await listSnapshots()).sort((a, b) => b.savedAt - a.savedAt);
}

export async function removeSnapshot(id: string): Promise<void> {
  await deleteSnapshot(id);
}

export async function restoreFromSnapshot(
  snapshot: BackupSnapshotMeta,
  mode: RestoreMode,
  onCourse?: (label: string, phase: 'restoring' | 'replacing' | 'skipping') => void,
) {
  const blob = await getSnapshotBlob(snapshot.id);
  if (!blob) throw new Error('Snapshot blob is missing from local storage.');
  const file = new File([blob], `snapshot-${snapshot.id}.zip`, { type: 'application/zip' });
  return restoreFullBackup(file, { mode, onCourse });
}
