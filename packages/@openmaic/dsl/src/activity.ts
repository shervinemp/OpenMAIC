/**
 * Activity scene content — hands-on practice with deterministic acceptance
 * checks.
 *
 * An activity is one scene with a `kind` family rather than one scene type per
 * exercise format. The contract deliberately stores only declarative inputs and
 * expectations: the runner (browser worker, simulated shell, or an
 * operator-gated isolated service) produces an {@link ActivityRunResult}, and a
 * pure evaluator decides pass/fail. Nothing here executes code.
 *
 * Learner-facing projections may read everything on a code activity except
 * `referenceFiles`; that field is authoring-only, used to prove the tests are
 * satisfiable before a lab ships.
 *
 * No runtime dependencies. Pure types + pure discriminant guards only.
 */

/** Every activity family owned by the contract. */
export type ActivityKind = 'code' | 'sql' | 'terminal';

/** Frozen set of every valid {@link ActivityKind}, for cheap membership checks. */
export const ACTIVITY_KINDS = [
  'code',
  'sql',
  'terminal',
] as const satisfies readonly ActivityKind[];

type _ActivityKindsExhaustive = [ActivityKind] extends [(typeof ACTIVITY_KINDS)[number]]
  ? true
  : never;
const _activityKindsExhaustive: _ActivityKindsExhaustive = true;
void _activityKindsExhaustive;

/** Narrow an unknown value to a valid {@link ActivityKind}. */
export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

/**
 * One file in an activity workspace. Paths are relative, forward-slash
 * separated, and never absolute or containing `..`; the runner rejects
 * escapes rather than resolving them.
 */
export interface ActivityFile {
  path: string;
  content: string;
  /**
   * Whether the learner may edit this file. Defaults to true. Data and test
   * fixtures are usually read-only so a lab cannot be "solved" by rewriting
   * its inputs.
   */
  editable?: boolean;
}

/**
 * One executable test. `code` is source in the activity's language; a test
 * passes when it runs to completion without raising. Tests are visible to the
 * learner unless `hidden` — and even hidden tests are only as private as the
 * runtime tier that holds them.
 */
export interface ActivityTest {
  id: string;
  name: string;
  code: string;
  hidden?: boolean;
}

/** How a textual expectation is compared. Defaults to `exact`. */
export type ActivityMatchMode = 'exact' | 'contains';

/** Value a SQL cell can hold after JSON transport. */
export type SqlValue = string | number | boolean | null;

/** Fields shared by every check. */
export interface ActivityCheckBase {
  /** Stable identity, unique within the activity. */
  id: string;
  /** Learner-facing label. The UI falls back to the check id when absent. */
  label?: string;
  /** Points awarded when the check passes. Defaults to 1. */
  points?: number;
  /** Hide the check's individual result from the learner. */
  hidden?: boolean;
}

/**
 * Every declared test (or the listed subset) passed. The runner executes the
 * tests; this check only interprets their outcomes, so a missing report is
 * ungraded rather than failed.
 */
export interface ActivityExpectTestsCheck extends ActivityCheckBase {
  type: 'expectTests';
  /** Test ids that must pass. Omitted means every declared test. */
  testIds?: string[];
}

/** Standard output of the submission's run matches the expectation. */
export interface ActivityExpectStdoutCheck extends ActivityCheckBase {
  type: 'expectStdout';
  expected: string;
  mode?: ActivityMatchMode;
}

/** A workspace file's final content matches the expectation. */
export interface ActivityExpectFileCheck extends ActivityCheckBase {
  type: 'expectFile';
  path: string;
  expected: string;
  mode?: ActivityMatchMode;
}

/**
 * A SQL probe returns the expected rows. Column order is significant. Row
 * order is ignored unless `ordered` is true (use it for ORDER BY exercises).
 */
export interface ActivityExpectSqlRowsCheck extends ActivityCheckBase {
  type: 'expectSqlRows';
  sql: string;
  expected: SqlValue[][];
  ordered?: boolean;
}

/**
 * A terminal session's state matches the expectation. `path` addresses the
 * runner's state snapshot: `cwd`, `env.NAME`, or `file:/path`.
 */
export interface ActivityExpectStateCheck extends ActivityCheckBase {
  type: 'expectState';
  path: string;
  expected: string;
}

/** Every check the contract knows about. Each kind narrows the subset. */
export type ActivityCheck =
  | ActivityExpectTestsCheck
  | ActivityExpectStdoutCheck
  | ActivityExpectFileCheck
  | ActivityExpectSqlRowsCheck
  | ActivityExpectStateCheck;

/** Checks valid on a code activity. */
export type CodeActivityCheck =
  | ActivityExpectTestsCheck
  | ActivityExpectStdoutCheck
  | ActivityExpectFileCheck;

/** Checks valid on a SQL activity. */
export type SqlActivityCheck = ActivityExpectSqlRowsCheck;

/** Checks valid on a terminal activity. */
export type TerminalActivityCheck =
  | ActivityExpectStdoutCheck
  | ActivityExpectFileCheck
  | ActivityExpectStateCheck;

/** Fields shared by every activity kind. */
export interface ActivityContentBase {
  type: 'activity';
  /** Markdown task brief shown above the workspace. */
  instructions: string;
  /** Progressive hints, revealed only on request. */
  hints?: string[];
  /** Markdown shown after every check passes. */
  debrief?: string;
  /** Wall-clock cap for one run, in seconds. Runners clamp to their own maximum. */
  timeLimitSec?: number;
}

/** A code exercise executed in a language runtime. */
export interface CodeActivityContent extends ActivityContentBase {
  kind: 'code';
  /** Runner language id, e.g. `python`. */
  language: string;
  /** Workspace file executed after the learner's edits, e.g. `main.py`. */
  entryFile: string;
  /** Files seeded into the workspace. */
  files: ActivityFile[];
  /** Tests the runner executes after the entry file. */
  tests: ActivityTest[];
  checks: CodeActivityCheck[];
  /**
   * Authoring-only reference workspace. It must pass every test and is never
   * imported by the learner runtime; projections that leave the authoring
   * surface omit it.
   */
  referenceFiles?: ActivityFile[];
}

/** A SQL exercise executed against an ephemeral database. */
export interface SqlActivityContent extends ActivityContentBase {
  kind: 'sql';
  /** Schema + seed statements executed before every attempt. */
  setupSql: string;
  /** Initial editor content. */
  starterSql: string;
  checks: SqlActivityCheck[];
  /** Authoring-only reference answer. */
  referenceSql?: string;
}

/**
 * A terminal exercise executed against a simulated shell. Simulation is the
 * deliberate default for command-line basics: it is deterministic, needs no
 * container, and cannot touch the host. Real command execution belongs to the
 * operator-gated isolation tier, not this kind.
 */
export interface TerminalActivityContent extends ActivityContentBase {
  kind: 'terminal';
  /** Initial simulated filesystem. */
  files: ActivityFile[];
  /** Authoring-only command sequence that satisfies every check. */
  referenceCommands?: string[];
  checks: TerminalActivityCheck[];
}

/** Activity scene content, discriminated by `kind`. */
export type ActivityContent = CodeActivityContent | SqlActivityContent | TerminalActivityContent;

/**
 * Cheap structural guard for {@link ActivityContent}. Checks the discriminant,
 * the common required fields, and that `checks` is an array; per-kind field
 * validation lives in `validateActivityContent`.
 */
export function isActivityContent(value: unknown): value is ActivityContent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const content = value as Record<string, unknown>;
  if (content.type !== 'activity') return false;
  if (!isActivityKind(content.kind)) return false;
  if (typeof content.instructions !== 'string') return false;
  if (!Array.isArray(content.checks)) return false;
  return true;
}

/** Narrow a candidate to {@link CodeActivityContent}. */
export function isCodeActivityContent(value: unknown): value is CodeActivityContent {
  return isActivityContent(value) && value.kind === 'code';
}

/** Narrow a candidate to {@link SqlActivityContent}. */
export function isSqlActivityContent(value: unknown): value is SqlActivityContent {
  return isActivityContent(value) && value.kind === 'sql';
}

/** Narrow a candidate to {@link TerminalActivityContent}. */
export function isTerminalActivityContent(value: unknown): value is TerminalActivityContent {
  return isActivityContent(value) && value.kind === 'terminal';
}
