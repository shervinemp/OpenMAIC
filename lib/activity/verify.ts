/**
 * Authoring-time verification for code activities.
 *
 * A lab is only trustworthy if its own reference solution passes every check
 * and its starter does not. The first proves the checks are satisfiable; the
 * second proves they measure the work the learner is asked to do. Both runs go
 * through the same runner the learner uses, and every harness failure is
 * reported as unverified — never silently treated as a pass.
 *
 * This module does not execute anything itself. It takes an {@link ActivityRunner}
 * so the same logic can run in the authoring UI (browser worker) or in a
 * server-side isolation service later.
 */
import type { ActivityFile, CodeActivityContent } from '@/lib/types/stage';
import { evaluateActivityChecks, type ActivityEvaluation } from './checks';
import { buildActivityRunRequest, type ActivityRunResult } from './protocol';
import type { ActivityRunner } from './code-runner';

export interface CodeActivityVerification {
  /** True only when the reference passes every check and the starter fails at least one. */
  ok: boolean;
  /** Human-readable reasons the lab is not verifiable. Empty when `ok`. */
  issues: string[];
  reference?: {
    result: ActivityRunResult;
    evaluation: ActivityEvaluation;
  };
  starter?: {
    result: ActivityRunResult;
    evaluation: ActivityEvaluation;
  };
}

export interface CodeActivityVerificationOptions {
  /** Skip the starter mutation run (reference-only check). Defaults to false. */
  referenceOnly?: boolean;
}

/** Merge reference files over the starter workspace without mutating either. */
export function referenceWorkspaceFiles(
  activity: CodeActivityContent,
): Record<string, string> | null {
  if (!activity.referenceFiles || activity.referenceFiles.length === 0) return null;
  return workspaceFiles(activity.files, activity.referenceFiles);
}

export function workspaceFiles(
  starter: readonly ActivityFile[],
  overrides: readonly ActivityFile[] = [],
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const file of starter) files[file.path] = file.content;
  for (const file of overrides) files[file.path] = file.content;
  return files;
}

function checkIssues(evaluation: ActivityEvaluation, phase: 'reference' | 'starter'): string[] {
  if (phase === 'reference') {
    return evaluation.results
      .filter((result) => result.status !== 'passed')
      .map(
        (result) =>
          `Reference solution ${result.status === 'failed' ? 'failed' : 'was not graded for'} check ${JSON.stringify(result.checkId)}${result.message ? `: ${result.message}` : '.'}`,
      );
  }
  return [];
}

/**
 * Verify a code activity. Both runs use the activity's own checks and time
 * limit; the reference run uses the merged reference workspace, the starter run
 * uses the untouched starter files.
 */
export async function verifyCodeActivity(
  activity: CodeActivityContent,
  runner: ActivityRunner,
  options: CodeActivityVerificationOptions = {},
): Promise<CodeActivityVerification> {
  const issues: string[] = [];

  if (activity.checks.length === 0) {
    return { ok: false, issues: ['The lab has no checks, so there is nothing to verify.'] };
  }

  const referenceFiles = referenceWorkspaceFiles(activity);
  if (!referenceFiles) {
    return {
      ok: false,
      issues: [
        'The lab has no reference solution. Add reference files so its checks can be proven satisfiable.',
      ],
    };
  }
  if (!(activity.entryFile in referenceFiles)) {
    return {
      ok: false,
      issues: [
        `The reference workspace does not contain the entry file ${JSON.stringify(activity.entryFile)}.`,
      ],
    };
  }

  const referenceRequest = buildActivityRunRequest(activity, {
    kind: 'code',
    files: referenceFiles,
  });
  if (!referenceRequest) {
    return {
      ok: false,
      issues: ['The reference workspace could not be submitted to the code runner.'],
    };
  }

  const referenceResult = await runner.run(referenceRequest);
  const referenceEvaluation = evaluateActivityChecks(activity, referenceResult);
  if (referenceResult.status !== 'ok') {
    issues.push(
      referenceResult.status === 'timeout'
        ? 'The reference solution timed out.'
        : `The reference run failed: ${referenceResult.error ?? 'unknown runner error'}.`,
    );
  } else if (!referenceEvaluation.passed) {
    issues.push(...checkIssues(referenceEvaluation, 'reference'));
  }

  const report: CodeActivityVerification = {
    ok: false,
    issues,
    reference: { result: referenceResult, evaluation: referenceEvaluation },
  };

  if (options.referenceOnly) {
    report.ok = issues.length === 0;
    return report;
  }
  if (issues.length > 0) return report;

  const starterRequest = buildActivityRunRequest(activity, {
    kind: 'code',
    files: workspaceFiles(activity.files),
  });
  if (!starterRequest) {
    report.issues.push('The starter workspace could not be submitted to the code runner.');
    return report;
  }

  const starterResult = await runner.run(starterRequest);
  const starterEvaluation = evaluateActivityChecks(activity, starterResult);
  report.starter = { result: starterResult, evaluation: starterEvaluation };

  if (starterResult.status !== 'ok') {
    report.issues.push(
      starterResult.status === 'timeout'
        ? 'The starter timed out instead of failing a check cleanly.'
        : `The starter run failed: ${starterResult.error ?? 'unknown runner error'}.`,
    );
    return report;
  }
  if (starterEvaluation.passed) {
    report.issues.push(
      'The starter already passes every check, so the lab asks the learner to do nothing.',
    );
    return report;
  }
  if (!starterEvaluation.results.some((result) => result.status === 'failed')) {
    report.issues.push(
      'The starter produced no definite failures, so the checks do not prove the task is incomplete.',
    );
    return report;
  }

  report.ok = true;
  return report;
}
