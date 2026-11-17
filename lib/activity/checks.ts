/**
 * Deterministic activity grading.
 *
 * The evaluator never executes anything: it compares a runner's reported
 * result against declarative checks. Missing or untrustworthy data is
 * `ungraded`, never a fabricated pass or an invented failure — the same rule
 * the quiz graders follow.
 */
import type {
  ActivityCheck,
  ActivityContent,
  ActivityExpectFileCheck,
  ActivityExpectSqlRowsCheck,
  ActivityExpectStateCheck,
  ActivityExpectStdoutCheck,
  ActivityExpectTestsCheck,
  ActivityTest,
  SqlValue,
} from '@/lib/types/stage';
import type {
  ActivityProbeRequest,
  ActivityRunResult,
  ActivitySqlProbeOutcome,
  ActivityTestOutcome,
} from './protocol';

export type ActivityCheckStatus = 'passed' | 'failed' | 'ungraded';

export interface ActivityCheckResult {
  checkId: string;
  status: ActivityCheckStatus;
  /** Points awarded. Zero for failed and ungraded checks. */
  earned: number;
  /** Points the check is worth when graded. */
  possible: number;
  /** Learner-facing explanation of a failure or an ungraded check. */
  message?: string;
  /** Actual output, kept for a diff in the UI. Omitted when unavailable. */
  actual?: string;
  /** Expected output, kept for a diff in the UI. */
  expected?: string;
  hidden?: boolean;
}

export interface ActivityEvaluation {
  results: ActivityCheckResult[];
  earned: number;
  possible: number;
  /** Percentage 0–100, or null when no check could be graded. */
  percent: number | null;
  /** True only when every check was graded and passed. */
  passed: boolean;
}

/** Trailing spaces and line-ending differences are never pedagogically meaningful. */
export function canonicalActivityText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

export function textMatches(
  actual: string,
  expected: string,
  mode?: 'exact' | 'contains',
): boolean {
  const a = canonicalActivityText(actual);
  const e = canonicalActivityText(expected);
  return mode === 'contains' ? a.includes(e) : a === e;
}

function checkPoints(check: ActivityCheck): number {
  const points = Number(check.points);
  return typeof check.points === 'number' && Number.isFinite(points) && points >= 0 ? points : 1;
}

function ungraded(check: ActivityCheck, message: string): ActivityCheckResult {
  return {
    checkId: check.id,
    status: 'ungraded',
    earned: 0,
    possible: checkPoints(check),
    message,
    hidden: check.hidden,
  };
}

function failed(
  check: ActivityCheck,
  message: string,
  expected?: string,
  actual?: string,
): ActivityCheckResult {
  return {
    checkId: check.id,
    status: 'failed',
    earned: 0,
    possible: checkPoints(check),
    message,
    expected,
    actual,
    hidden: check.hidden,
  };
}

function passed(check: ActivityCheck): ActivityCheckResult {
  return {
    checkId: check.id,
    status: 'passed',
    earned: checkPoints(check),
    possible: checkPoints(check),
    hidden: check.hidden,
  };
}

function evaluateExpectTests(
  check: ActivityExpectTestsCheck,
  declaredTests: ActivityTest[],
  outcomes: ActivityTestOutcome[] | undefined,
): ActivityCheckResult {
  if (declaredTests.length === 0) {
    return ungraded(check, 'This lab declares no tests, so the test check cannot be graded.');
  }
  const declared = new Map(declaredTests.map((test) => [test.id, test]));
  const required = check.testIds ?? declaredTests.map((test) => test.id);
  if (required.length === 0) {
    return ungraded(check, 'The test check names no tests, so it cannot be graded.');
  }
  const unknown = required.filter((id) => !declared.has(id));
  if (unknown.length > 0) {
    return ungraded(
      check,
      `The check refers to undeclared tests: ${unknown.map((id) => JSON.stringify(id)).join(', ')}.`,
    );
  }
  if (!outcomes) {
    return ungraded(check, 'The runner did not report test results.');
  }
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  const missing = required.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return ungraded(
      check,
      `The runner did not report ${missing.map((id) => JSON.stringify(id)).join(', ')}.`,
    );
  }
  const failing = required
    .map((id) => byId.get(id) as ActivityTestOutcome)
    .filter((outcome) => !outcome.passed);
  if (failing.length === 0) return passed(check);
  const labels = failing.map((outcome) => declared.get(outcome.id)?.name ?? outcome.id);
  return failed(check, `Failing tests: ${labels.join(', ')}.`, undefined, failing[0]?.message);
}

function evaluateExpectStdout(
  check: ActivityExpectStdoutCheck,
  stdout: string | undefined,
): ActivityCheckResult {
  if (stdout === undefined) return ungraded(check, 'The runner did not report standard output.');
  if (textMatches(stdout, check.expected, check.mode)) return passed(check);
  return failed(
    check,
    check.mode === 'contains'
      ? 'The output does not contain the expected text.'
      : 'The output does not match the expected text.',
    check.expected,
    stdout,
  );
}

function evaluateExpectFile(
  check: ActivityExpectFileCheck,
  files: Record<string, string> | undefined,
): ActivityCheckResult {
  if (!files) return ungraded(check, 'The runner did not report workspace files.');
  const actual = files[check.path];
  if (actual === undefined) {
    return failed(check, `Expected file ${JSON.stringify(check.path)} was not produced.`);
  }
  if (textMatches(actual, check.expected, check.mode)) return passed(check);
  return failed(
    check,
    `File ${JSON.stringify(check.path)} does not match the expected content.`,
    check.expected,
    actual,
  );
}

function sqlValuesEqual(a: SqlValue, b: SqlValue): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9;
  }
  if (typeof a === 'number' || typeof b === 'number') {
    // Databases differ on whether a numeric cell arrives as a number or a
    // string ("12" vs 12). Compare the numeric reading when both parse.
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) <= 1e-9;
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  return String(a) === String(b);
}

function rowsEqual(actual: SqlValue[], expected: SqlValue[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((cell, i) => sqlValuesEqual(cell, expected[i]))
  );
}

function describeRows(rows: SqlValue[][] | undefined): string | undefined {
  if (!rows) return undefined;
  return JSON.stringify(rows);
}

function evaluateExpectSqlRows(
  check: ActivityExpectSqlRowsCheck,
  probes: Record<string, ActivitySqlProbeOutcome> | undefined,
  probeRequests: ActivityProbeRequest[] | undefined,
): ActivityCheckResult {
  if (!probes) return ungraded(check, 'The runner did not report SQL results.');
  // The probe list is derived from the checks, so a missing request means the
  // activity and its checks disagree — an authoring error, not a learner one.
  if (probeRequests && !probeRequests.some((probe) => probe.id === check.id)) {
    return ungraded(check, 'This check has no matching SQL probe.');
  }
  const outcome = probes[check.id];
  if (!outcome) return ungraded(check, 'The runner did not report this SQL probe.');
  if (outcome.error !== undefined) {
    return failed(
      check,
      'The probe query could not run after your submission.',
      undefined,
      outcome.error,
    );
  }
  if (!outcome.rows) return ungraded(check, 'The SQL probe reported no rows.');
  const expected = check.expected;
  const actual = outcome.rows;
  const expectedText = describeRows(expected);
  const actualText = describeRows(actual);
  if (check.ordered) {
    if (expected.length !== actual.length) {
      return failed(
        check,
        `The query returned ${actual.length} row(s); expected ${expected.length}.`,
        expectedText,
        actualText,
      );
    }
    const mismatch = expected.findIndex((row, i) => !rowsEqual(actual[i] ?? [], row));
    if (mismatch === -1) return passed(check);
    return failed(
      check,
      `Row ${mismatch + 1} does not match the expected result.`,
      expectedText,
      actualText,
    );
  }
  if (expected.length !== actual.length) {
    return failed(
      check,
      `The query returned ${actual.length} row(s); expected ${expected.length}.`,
      expectedText,
      actualText,
    );
  }
  const used = new Array(actual.length).fill(false);
  for (const expectedRow of expected) {
    const index = actual.findIndex((row, i) => !used[i] && rowsEqual(row, expectedRow));
    if (index === -1) {
      return failed(
        check,
        'The query result does not contain every expected row.',
        expectedText,
        actualText,
      );
    }
    used[index] = true;
  }
  return passed(check);
}

function evaluateExpectState(
  check: ActivityExpectStateCheck,
  state: Record<string, string> | undefined,
  files: Record<string, string> | undefined,
): ActivityCheckResult {
  let actual = state?.[check.path];
  if (actual === undefined && check.path.startsWith('file:')) {
    actual = files?.[check.path.slice('file:'.length)];
  }
  if (actual === undefined) {
    if (!state && !files) return ungraded(check, 'The runner did not report session state.');
    return failed(check, `Session state ${JSON.stringify(check.path)} is missing.`, check.expected);
  }
  if (textMatches(actual, check.expected)) return passed(check);
  return failed(
    check,
    `Session state ${JSON.stringify(check.path)} does not match the expected value.`,
    check.expected,
    actual,
  );
}

function evaluateCheck(
  check: ActivityCheck,
  declaredTests: ActivityTest[],
  report: ActivityRunResult,
  probeRequests: ActivityProbeRequest[] | undefined,
): ActivityCheckResult {
  switch (check.type) {
    case 'expectTests':
      return evaluateExpectTests(check, declaredTests, report.tests);
    case 'expectStdout':
      return evaluateExpectStdout(check, report.stdout);
    case 'expectFile':
      return evaluateExpectFile(check, report.files);
    case 'expectSqlRows':
      return evaluateExpectSqlRows(check, report.sqlProbes, probeRequests);
    case 'expectState':
      return evaluateExpectState(check, report.state, report.files);
  }
}

function selectProbeRequests(activity: ActivityContent): ActivityProbeRequest[] | undefined {
  if (activity.kind !== 'sql') return undefined;
  return activity.checks.map((check) => ({ id: check.id, sql: check.sql }));
}

/**
 * Evaluate every check against one run.
 *
 * A runner-level failure (`status: 'error' | 'timeout'`) makes every check
 * ungraded: we know nothing about the submission, and blaming the learner for
 * a harness failure would be a fabricated score. Per-check missing data is
 * ungraded for the same reason; contradictory-but-present data is a failure.
 */
export function evaluateActivityChecks(
  activity: ActivityContent,
  report: ActivityRunResult,
): ActivityEvaluation {
  const declaredTests = activity.kind === 'code' ? activity.tests : [];
  const probeRequests = selectProbeRequests(activity);
  const checks: readonly ActivityCheck[] = activity.checks;

  const results: ActivityCheckResult[] = checks.map((check) => {
    if (report.status !== 'ok') {
      const reason =
        report.status === 'timeout'
          ? 'The run timed out, so this check was not graded.'
          : 'The runner failed, so this check was not graded.';
      return ungraded(check, reason);
    }
    return evaluateCheck(check, declaredTests, report, probeRequests);
  });

  const earned = results.reduce((sum, result) => sum + result.earned, 0);
  const possible = results.reduce(
    (sum, result) => sum + (result.status === 'ungraded' ? 0 : result.possible),
    0,
  );
  return {
    results,
    earned,
    possible,
    percent: possible > 0 ? (earned / possible) * 100 : null,
    passed: results.length > 0 && results.every((result) => result.status === 'passed'),
  };
}

/**
 * Project an activity onto learner-facing content: hidden tests and every
 * authoring-only reference are removed. The returned object is always a fresh
 * copy, so a caller can render it without mutating the stored scene.
 */
export function projectActivityForLearner(activity: ActivityContent): ActivityContent {
  const common = {
    type: 'activity' as const,
    instructions: activity.instructions,
    hints: activity.hints ? [...activity.hints] : undefined,
    debrief: activity.debrief,
    timeLimitSec: activity.timeLimitSec,
    concepts: activity.concepts ? [...activity.concepts] : undefined,
  };
  if (activity.kind === 'code') {
    return {
      ...common,
      kind: 'code',
      language: activity.language,
      entryFile: activity.entryFile,
      files: activity.files.map((file) => ({ ...file })),
      tests: activity.tests.filter((test) => !test.hidden).map((test) => ({ ...test })),
      checks: activity.checks.map((check) => ({ ...check })),
    };
  }
  if (activity.kind === 'sql') {
    return {
      ...common,
      kind: 'sql',
      setupSql: activity.setupSql,
      starterSql: activity.starterSql,
      checks: activity.checks.map((check) => ({ ...check })),
    };
  }
  return {
    ...common,
    kind: 'terminal',
    runtime: activity.runtime,
    files: activity.files.map((file) => ({ ...file })),
    checks: activity.checks.map((check) => ({ ...check })),
  };
}
