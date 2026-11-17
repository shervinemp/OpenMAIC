/**
 * Runner protocol for activity scenes.
 *
 * This module is the seam between a runner implementation (Pyodide worker,
 * PGlite worker, simulated shell, isolated service) and the pure evaluator in
 * `checks.ts`. It deliberately contains no execution code: the request carries
 * everything the runner needs, and the result reports what happened without
 * interpreting it. A runner that cannot produce a real result reports
 * `status: 'error'` instead of inventing output.
 */
import type { ActivityKind, ActivityTest, SqlValue } from '@/lib/types/stage';

/** One learner submission, discriminated by the activity family. */
export type ActivitySubmission =
  | { kind: 'code'; files: Record<string, string> }
  | { kind: 'sql'; sql: string }
  | { kind: 'terminal'; commands: string[] };

/** Everything a runner needs for one attempt. */
export interface ActivityRunRequest {
  kind: ActivityKind;
  /** Hard wall-clock cap. The runner kills execution when it expires. */
  timeLimitMs: number;
  /** Code: workspace files after the learner's edits, path -> content. */
  files?: Record<string, string>;
  /** Code: the file executed after workspace setup. */
  entryFile?: string;
  /** Code: tests executed after the entry file. */
  tests?: ActivityTest[];
  /** SQL: schema + seed statements executed before every attempt. */
  setupSql?: string;
  /** SQL: the learner's statements. */
  submissionSql?: string;
  /** SQL: probe queries whose rows the checks compare. */
  sqlProbes?: ActivityProbeRequest[];
  /** Terminal: initial simulated filesystem. */
  initialFiles?: Record<string, string>;
  /** Terminal: commands entered by the learner, in order. */
  commands?: string[];
}

export interface ActivityProbeRequest {
  id: string;
  sql: string;
}

/** Outcome of one test. `message` carries a failure trace or assertion text. */
export interface ActivityTestOutcome {
  id: string;
  passed: boolean;
  message?: string;
}

/** One SQL probe. Rows and errors are mutually exclusive. */
export interface ActivitySqlProbeOutcome {
  /** Columns in result order, when the engine reports them. */
  columns?: string[];
  rows?: SqlValue[][];
  error?: string;
}

export interface ActivityRunResult {
  /**
   * `ok` means the runner completed; learner code may still have thrown.
   * `timeout` and `error` mean no trustworthy result exists, so every check
   * stays ungraded rather than being blamed on the learner.
   */
  status: 'ok' | 'timeout' | 'error';
  /** Captured standard output, already decoded to text. */
  stdout: string;
  /** Captured standard error, already decoded to text. */
  stderr: string;
  /** Process-style exit code, when the runner has one. */
  exitCode?: number | null;
  /** Files after the run, path -> content. Missing paths were removed. */
  files?: Record<string, string>;
  tests?: ActivityTestOutcome[];
  sqlProbes?: Record<string, ActivitySqlProbeOutcome>;
  /** Terminal session snapshot addressed by `expectState` paths. */
  state?: Record<string, string>;
  /** Runner-level failure detail (engine load failure, protocol violation). */
  error?: string;
  durationMs: number;
}

/**
 * Build the runner request for a submission. Returns null when the submission
 * does not belong to the activity (a code submission for a SQL lab): the
 * caller must surface that as a bad request, never run it against the wrong
 * engine.
 */
export function buildActivityRunRequest(
  activity:
    | {
        kind: 'code';
        language: string;
        entryFile: string;
        tests: ActivityTest[];
        timeLimitSec?: number;
      }
    | {
        kind: 'sql';
        setupSql: string;
        checks: { id: string; sql: string }[];
        timeLimitSec?: number;
      }
    | { kind: 'terminal'; files: { path: string; content: string }[]; timeLimitSec?: number },
  submission: ActivitySubmission,
): ActivityRunRequest | null {
  if (activity.kind !== submission.kind) return null;
  const timeLimitMs = clampTimeLimitMs(activity.timeLimitSec);

  if (activity.kind === 'code' && submission.kind === 'code') {
    return {
      kind: 'code',
      timeLimitMs,
      files: submission.files,
      entryFile: activity.entryFile,
      tests: activity.tests,
    };
  }
  if (activity.kind === 'sql' && submission.kind === 'sql') {
    return {
      kind: 'sql',
      timeLimitMs,
      setupSql: activity.setupSql,
      submissionSql: submission.sql,
      sqlProbes: activity.checks.map((check) => ({ id: check.id, sql: check.sql })),
    };
  }
  if (activity.kind === 'terminal' && submission.kind === 'terminal') {
    const initialFiles: Record<string, string> = {};
    for (const file of activity.files) initialFiles[file.path] = file.content;
    return {
      kind: 'terminal',
      timeLimitMs,
      initialFiles,
      commands: submission.commands,
    };
  }
  return null;
}

/** Default 15s, hard ceiling 120s. A lab that legitimately needs longer is a
 * design smell, not a cap to raise silently. */
export const DEFAULT_ACTIVITY_TIME_LIMIT_MS = 15_000;
export const MAX_ACTIVITY_TIME_LIMIT_MS = 120_000;

export function clampTimeLimitMs(seconds: number | undefined): number {
  const raw = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ACTIVITY_TIME_LIMIT_MS;
  return Math.min(Math.max(Math.round(raw), 1000), MAX_ACTIVITY_TIME_LIMIT_MS);
}
