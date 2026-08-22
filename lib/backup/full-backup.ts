/**
 * Full local backup / restore for OpenMAIC.
 *
 * `exportFullBackup` downloads a single ZIP with:
 *   - `manifest.json`    — full-backup metadata, including the per-course
 *     `courses` table (name + original stage id) used for duplicate-aware
 *     restores
 *   - `courses/<n>-<name>/…` — every course in the same per-course layout the
 *     single-classroom export uses (rebuilt via `addStageContentToZip` from the
 *     persisted document, so no in-memory store is required)
 *   - `settings.json`    — persisted settings with API keys/tokens stripped
 *
 * `buildFullBackupZip` produces the same ZIP in memory (no download) so the
 * automatic snapshot feature can keep local copies without touching disk.
 *
 * `restoreFullBackup` replays each course through the same import pipeline used
 * by the single-course importer (`importClassroomZip`) and can optionally
 * replace or skip courses it can recognise as already-present (matched by the
 * source stage id recorded at export time, with a name-based fallback). It
 * merges non-secret settings back into the current KV store — a sanitized
 * backup never wipes your credentials.
 */
import { saveAs } from 'file-saver';
import type JSZip from 'jszip';

import { BrowserKVStore } from '@openmaic/storage';
import { deleteStageData, listStages } from '@/lib/utils/stage-storage';
import { accessDocument } from '@/lib/document-store';
import { addStageContentToZip } from '@/lib/export/build-classroom-zip';
import { importClassroomZip } from '@/lib/import/use-import-classroom';
import type { Scene, Stage } from '@/lib/types/stage';
import { createLogger } from '@/lib/logger';

const log = createLogger('FullBackup');

export const FULL_BACKUP_FORMAT = 'openmaic-full-backup';
export const FULL_BACKUP_VERSION = 2;
export const SETTINGS_KV_KEY = 'settings-storage';
export const SETTINGS_KV_SCOPE = 'account' as const;

export interface BackupCourse {
  /** Path of the course subtree inside the ZIP, e.g. `courses/001-name`. */
  path: string;
  name: string;
  /** The stage id the course had when the backup was created. */
  sourceId: string;
}

export interface FullBackupManifest {
  format: string;
  version: number;
  exportedAt: string;
  appVersion?: string;
  courseCount: number;
  settingsIncluded: boolean;
  courses: BackupCourse[];
}

export type RestoreMode = 'replace' | 'skip' | 'add';

export interface RestoreBackupOptions {
  /**
   * How to handle a course that is already present in this browser:
   *  - `replace` (default): import the backed-up copy, then delete the old
   *    stage only after the import commits (a failed import never loses the
   *    existing course).
   *  - `skip`: keep the existing course untouched, skip the import.
   *  - `add`: always import a fresh copy (duplicates on purpose).
   */
  mode?: RestoreMode;
  onCourse?: (label: string, phase: 'restoring' | 'replacing' | 'skipping') => void;
}

function sanitizeFileName(name: string): string {
  const safe = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return safe || 'untitled';
}

/** Keys that carry credentials; never written to / read back from a backup. */
function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes('apikey') ||
    lower === 'api_key' ||
    lower.includes('accesskey') ||
    lower.includes('secret') ||
    lower.includes('token')
  );
}

export function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key)) continue;
      out[key] = sanitizeValue(entry);
    }
    return out;
  }
  return value;
}

/** Deep-merge the (already sanitized) backup into the live settings. */
export function mergeSettings(existing: unknown, incoming: unknown): unknown {
  if (incoming === undefined) return existing;
  if (Array.isArray(incoming)) {
    // Array-region semantics: merge index-by-index so entries the backup does
    // not carry (it is sanitized, so credentials are always absent) survive.
    if (!Array.isArray(existing)) return incoming;
    const length = Math.max(incoming.length, existing.length);
    const merged: unknown[] = new Array(length);
    for (let index = 0; index < length; index++) {
      merged[index] = mergeSettings(existing[index], incoming[index]);
    }
    return merged;
  }
  if (
    incoming !== null &&
    typeof incoming === 'object' &&
    existing !== null &&
    typeof existing === 'object'
  ) {
    const target = { ...(existing as Record<string, unknown>) };
    for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
      if (isSecretKey(key)) continue;
      if (value !== null && typeof value === 'object' && !isSecretKey(key)) {
        target[key] = mergeSettings(target[key], value);
      } else {
        target[key] = value;
      }
    }
    return target;
  }
  return incoming;
}

export interface BuiltFullBackup {
  blob: Blob;
  manifest: FullBackupManifest;
  packed: number;
}

/** Build the full-backup ZIP in memory (no download). Shared by export + snapshots. */
export async function buildFullBackupZip(
  onCourse?: (courseIndex: number, total: number, name: string) => void,
): Promise<BuiltFullBackup> {
  const courses = await listStages();
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const exportedAt = new Date().toISOString();

  const packedCourses: BackupCourse[] = [];
  for (let index = 0; index < courses.length; index++) {
    const course = courses[index];
    onCourse?.(index + 1, courses.length, course.name || 'untitled');
    try {
      const access = await accessDocument(course.id);
      if (!access.document) continue;
      const prefix = `courses/${String(index + 1).padStart(3, '0')}-${sanitizeFileName(course.name)}`;
      await addStageContentToZip(
        zip,
        access.document.stage as Stage,
        access.document.scenes as Scene[],
        {
          prefix,
          latestName: access.document.stage.name,
        },
      );
      packedCourses.push({
        path: prefix,
        name: access.document.stage.name || 'untitled',
        sourceId: access.document.stage.id,
      });
    } catch (error) {
      log.error(`Full backup: failed to pack course ${course.id} (${course.name}):`, error);
    }
  }

  // Settings (credentials stripped).
  const kv = new BrowserKVStore();
  const stored = await kv.get<{ state?: unknown; version?: number }>(
    SETTINGS_KV_KEY,
    SETTINGS_KV_SCOPE,
  );
  let settingsIncluded = false;
  if (stored?.state) {
    zip.file(
      'settings.json',
      JSON.stringify({ state: sanitizeValue(stored.state), version: stored.version ?? 4 }, null, 2),
    );
    settingsIncluded = true;
  }

  const manifest: FullBackupManifest = {
    format: FULL_BACKUP_FORMAT,
    version: FULL_BACKUP_VERSION,
    exportedAt,
    appVersion: process.env.npm_package_version || '0.0.0',
    courseCount: packedCourses.length,
    settingsIncluded,
    courses: packedCourses,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  const blob = await zip.generateAsync({ type: 'blob' });
  return { blob, manifest, packed: packedCourses.length };
}

export interface FullBackupResult {
  courses: number;
  settingsIncluded: boolean;
  size: number;
}

export async function exportFullBackup(
  onCourse?: (courseIndex: number, total: number, name: string) => void,
): Promise<FullBackupResult> {
  const { blob, manifest, packed } = await buildFullBackupZip(onCourse);
  const date = manifest.exportedAt.slice(0, 10);
  saveAs(blob, `openmaic-full-backup-${date}.zip`);
  return { courses: packed, settingsIncluded: manifest.settingsIncluded, size: blob.size };
}

export interface RestoreBackupResult {
  restored: number;
  replaced: number;
  skipped: number;
  failed: number;
  settingsRestored: boolean;
}

interface ExistingStage {
  id: string;
  name: string;
}

async function findExistingStages(): Promise<ExistingStage[]> {
  try {
    return (await listStages()).map((stage) => ({ id: stage.id, name: stage.name || '' }));
  } catch (error) {
    log.error('Restore: could not enumerate existing stages:', error);
    return [];
  }
}

function courseDirOf(manifestCourses: BackupCourse[], dir: string): BackupCourse | undefined {
  const normalized = dir.replace(/\/$/, '');
  return manifestCourses.find((course) => course.path.replace(/\/$/, '') === normalized);
}

export async function restoreFullBackup(
  file: File | Blob | ArrayBuffer | Uint8Array,
  options: RestoreBackupOptions = {},
): Promise<RestoreBackupResult> {
  const mode: RestoreMode = options.mode ?? 'replace';
  const JSZip = (await import('jszip')).default;

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error('Invalid backup file (not a readable ZIP).');
  }

  const manifestEntry = zip.file('manifest.json');
  if (!manifestEntry) throw new Error('Invalid backup file (missing manifest.json).');
  let manifest: FullBackupManifest;
  try {
    manifest = JSON.parse(await manifestEntry.async('text'));
  } catch {
    throw new Error('Invalid backup file (malformed manifest.json).');
  }
  if (manifest.format !== FULL_BACKUP_FORMAT || manifest.version !== FULL_BACKUP_VERSION) {
    throw new Error(
      `Unsupported backup format (${manifest.format ?? 'unknown'} v${manifest.version ?? '?'}).`,
    );
  }

  // Top-level folder per course: `courses/<n>-<name>/…`
  const courseDirs = new Set<string>();
  for (const path of Object.keys(zip.files)) {
    const match = /^courses\/[^/]+\//.exec(path);
    if (match) courseDirs.add(match[0]);
  }
  const sortedDirs = [...courseDirs].sort();
  const existingStages = mode === 'add' ? [] : await findExistingStages();

  const result: RestoreBackupResult = {
    restored: 0,
    replaced: 0,
    skipped: 0,
    failed: 0,
    settingsRestored: false,
  };

  for (const dir of sortedDirs) {
    const label = dir.replace(/^courses\//, '').replace(/\/$/, '');
    const backupCourse = courseDirOf(manifest.courses ?? [], dir);
    const duplicate = backupCourse
      ? (existingStages.find((stage) => stage.id === backupCourse.sourceId) ??
        existingStages.find((stage) => stage.name === backupCourse.name))
      : undefined;

    if (duplicate && mode === 'skip') {
      options.onCourse?.(label, 'skipping');
      result.skipped += 1;
      continue;
    }
    if (duplicate && mode === 'replace') {
      options.onCourse?.(label, 'replacing');
    } else {
      options.onCourse?.(label, 'restoring');
    }

    try {
      const courseZip = new JSZip();
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        if (!path.startsWith(dir)) continue;
        courseZip.file(path.slice(dir.length), await entry.async('uint8array'));
      }
      await importClassroomZip(courseZip);
      // Replace only after the import committed: a failed import must never
      // destroy the course the user already has.
      if (duplicate && mode === 'replace') {
        await deleteStageData(duplicate.id);
        result.replaced += 1;
      } else {
        result.restored += 1;
      }
    } catch (error) {
      log.error(`Full backup restore: course "${label}" failed:`, error);
      result.failed += 1;
    }
  }

  // Settings: merge non-secret keys only, keep any live credentials intact.
  const settingsFile = zip.file('settings.json');
  if (settingsFile) {
    try {
      const parsed = JSON.parse(await settingsFile.async('text'));
      const kv = new BrowserKVStore();
      const existing = await kv.get<{ state?: unknown; version?: number }>(
        SETTINGS_KV_KEY,
        SETTINGS_KV_SCOPE,
      );
      const merged = mergeSettings(existing?.state, parsed.state);
      await kv.set(
        SETTINGS_KV_KEY,
        { state: merged, version: parsed.version ?? existing?.version ?? 4 },
        SETTINGS_KV_SCOPE,
      );
      result.settingsRestored = true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        log.error('Full backup restore: settings quota exceeded:', error);
        throw new Error('Storage is full; cannot restore settings. Courses were restored.');
      }
      log.error('Full backup restore: settings merge failed:', error);
    }
  }

  return result;
}
