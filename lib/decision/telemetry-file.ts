/**
 * Best-effort persistence for decision telemetry.
 *
 * Shadow mode is only useful across a deployment's lifetime: a restart that
 * dropped every counter would make agreement impossible to evaluate. The
 * snapshot is therefore written next to the other file-backed state and
 * merged once at boot.
 *
 * This is diagnostics, not accounting. Writes are debounced and atomic, and a
 * failure only warns. Multiple processes sharing one file are last-writer-wins;
 * that is acceptable for an operator report and documented in the README.
 */

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

import { createLogger } from '@/lib/logger';

import { mergeDecisionTelemetry, snapshotDecisionTelemetry } from './telemetry';

const log = createLogger('decision-telemetry');

const FLUSH_DELAY_MS = 500;

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let writing = false;
let pending = false;
const loadedFiles = new Set<string>();

function isTestEnv(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
}

/**
 * `<DECISION_TELEMETRY_FILE>` wins, then the file-backed persistence root,
 * then the app's ordinary data directory. Resolved per call so tests can point
 * one snapshot at a throwaway file without resetting module state.
 */
export function decisionTelemetryFile(): string {
  const configured = process.env.DECISION_TELEMETRY_FILE?.trim();
  if (configured) return path.resolve(configured);
  const persistenceDir = process.env.PERSISTENCE_DIR?.trim();
  if (persistenceDir) {
    return path.join(path.resolve(persistenceDir), 'decision-telemetry.json');
  }
  return path.join(process.cwd(), 'data', 'decision-telemetry.json');
}

/**
 * Read one snapshot into the live counters. Missing files are normal; a
 * malformed file is ignored with a warning so boot never depends on it.
 *
 * Tests never touch the real data directory unless they pass an explicit
 * file, so a leftover local snapshot cannot change a test's counter baseline.
 */
export function loadDecisionTelemetryFromDisk(file?: string): void {
  if (!file && isTestEnv()) return;
  const target = file ?? decisionTelemetryFile();
  if (loadedFiles.has(target)) return;
  loadedFiles.add(target);
  try {
    const raw = readFileSync(target, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    mergeDecisionTelemetry(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Could not load the decision telemetry snapshot; starting fresh.', error);
    }
  }
}

async function writeSnapshot(file: string): Promise<void> {
  const snapshot = {
    ...snapshotDecisionTelemetry(),
    savedAt: Date.now(),
  };
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(snapshot, null, 2), 'utf-8');
  await fs.rename(temp, file);
}

/**
 * Persist the current counters now. Coalesces overlapping calls: a write that
 * starts while another is in flight causes exactly one follow-up write, so the
 * file converges on the latest snapshot without a write per decision.
 */
export async function flushDecisionTelemetry(file = decisionTelemetryFile()): Promise<void> {
  if (writing) {
    pending = true;
    return;
  }
  writing = true;
  try {
    do {
      pending = false;
      try {
        await writeSnapshot(file);
      } catch (error) {
        // A diagnostics write must never affect a learner request.
        log.warn('Could not persist the decision telemetry snapshot (ignored).', error);
        break;
      }
    } while (pending);
  } finally {
    writing = false;
  }
}

/** Debounced flush used after every decision event. No-op under tests. */
export function scheduleDecisionTelemetryFlush(): void {
  if (isTestEnv() || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushDecisionTelemetry();
  }, FLUSH_DELAY_MS);
  flushTimer.unref?.();
}

/** Tests need a deterministic slate; production never calls this. */
export function resetDecisionTelemetryFileForTests(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  writing = false;
  pending = false;
  loadedFiles.clear();
}
