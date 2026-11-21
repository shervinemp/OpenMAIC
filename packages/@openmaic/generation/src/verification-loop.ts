/**
 * Bounded verify -> correct -> re-verify driver shared by the content verifiers.
 *
 * The older audit path did a single corrective pass and then shipped the retry
 * without ever checking it again. That meant a defect which survived one pass
 * was recorded and shipped, and a retry that regressed was shipped too. This
 * driver makes the correction observable: every retry is re-verified, the loop
 * stops as soon as it is clean, and on exhaustion the *best* artifact (the one
 * with the fewest remaining findings) is kept rather than the last one.
 *
 * Everything is fail-open: a null retry keeps the current artifact, a throwing
 * verifier is treated as "no findings" by the caller's safe wrapper, and a
 * clean verdict on the first pass costs nothing extra.
 */

export interface VerificationIssue {
  code: string;
  message: string;
}

export interface CorrectiveLoopOptions<T> {
  /** Produce a fresh artifact, optionally steered by cumulative findings. */
  generate: (feedback: string | undefined) => Promise<T | null>;
  /** Verify an artifact. The safe model-backed wrappers already fail open. */
  verify: (artifact: T) => Promise<readonly VerificationIssue[]>;
  /** Turn cumulative findings into model-facing correction text. */
  summarize: (issues: readonly VerificationIssue[]) => string;
  /** Number of corrective passes allowed (not counting the initial artifact). */
  maxAttempts: number;
  /** Optional progress hook for the host logger. */
  onProgress?: (info: { pass: number; issues: readonly VerificationIssue[] }) => void;
}

export interface CorrectiveLoopResult<T> {
  artifact: T;
  issues: readonly VerificationIssue[];
  passes: number;
  clean: boolean;
}

function issueKey(issue: VerificationIssue): string {
  return `${issue.code}::${issue.message}`;
}

export type FindingClass = 'environmental' | 'mechanical' | 'semantic';

/** Deterministic findings: concrete, highly actionable, worth another pass. */
const MECHANICAL_CODES = new Set([
  'script-error',
  'dead-control',
  'outline-variable-missing',
  'inert-preset',
  'non-finite-state',
  'no-observation',
  'qualifier-conflict',
  'premise-conflict',
]);

/** Harness gaps a re-prompt cannot fix; stub them in the probe instead. */
const ENVIRONMENTAL_CODES = new Set(['probe-environment']);
const BROWSER_GLOBALS = new Set([
  'CanvasRenderingContext2D',
  'CanvasGradient',
  'CanvasPattern',
  'ImageData',
  'Path2D',
  'HTMLCanvasElement',
  'OffscreenCanvas',
  'Image',
  'AudioContext',
  'ResizeObserver',
  'IntersectionObserver',
  'MutationObserver',
  'TextEncoder',
  'TextDecoder',
  'Blob',
  'FileReader',
  'WebSocket',
  'matchMedia',
  'fetch',
]);

export function classifyFinding(issue: VerificationIssue): FindingClass {
  if (ENVIRONMENTAL_CODES.has(issue.code)) return 'environmental';
  if (MECHANICAL_CODES.has(issue.code)) {
    // A "script error" can also be a missing browser global in the probe.
    const missing = /\b([A-Za-z_$][\w$]*)\s+is not defined\b/.exec(issue.message)?.[1];
    if (missing && BROWSER_GLOBALS.has(missing)) return 'environmental';
    return 'mechanical';
  }
  return 'semantic';
}

/**
 * Corrective passes allowed for a given finding set. Environmental findings
 * get none, semantic findings get at most one (live runs showed a second pass
 * trades one defect for another), and mechanical findings get the full budget.
 */
export function correctiveBudget(
  issues: readonly VerificationIssue[],
  maxAttempts: number,
): number {
  if (issues.length === 0 || maxAttempts <= 0) return 0;
  const classes = new Set(issues.map(classifyFinding));
  if (classes.size === 1 && classes.has('environmental')) return 0;
  if (classes.has('mechanical')) return maxAttempts;
  return Math.min(1, maxAttempts);
}

/** Accumulate findings across passes so fixing one cannot hide an earlier one. */
function accumulate(
  prior: readonly VerificationIssue[],
  current: readonly VerificationIssue[],
): VerificationIssue[] {
  const seen = new Set(prior.map(issueKey));
  const merged = [...prior];
  for (const issue of current) {
    const key = issueKey(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(issue);
  }
  return merged;
}

/**
 * Start from an already-generated artifact, then correct and re-verify it up to
 * `maxAttempts` times. The initial artifact is never regenerated just to start
 * the loop, so a caller that has already applied other gates (language, media)
 * keeps that work.
 */
export async function correctUntilClean<T>(
  initialArtifact: T,
  options: CorrectiveLoopOptions<T>,
): Promise<CorrectiveLoopResult<T>> {
  let artifact = initialArtifact;
  let issues: readonly VerificationIssue[] = await options.verify(initialArtifact);
  let cumulative: readonly VerificationIssue[] = [];
  let passes = 0;

  while (issues.length > 0 && passes < correctiveBudget(issues, options.maxAttempts)) {
    passes += 1;
    cumulative = accumulate(cumulative, issues);
    options.onProgress?.({ pass: passes, issues });

    const candidate = await options.generate(options.summarize(cumulative));
    // A null retry is not a better artifact: keep what we already have and stop
    // rather than spending the remaining passes on a broken generation path.
    if (candidate === null) break;

    const candidateIssues = await options.verify(candidate);
    // Learn from the candidate too, even if it is not good enough to keep.
    // A rewrite can fix one defect and introduce another of equal severity;
    // dropping that new finding would let the loop spin without ever telling
    // the model what it needs to correct.
    cumulative = accumulate(cumulative, candidateIssues);
    if (candidateIssues.length === 0) {
      return { artifact: candidate, issues: [], passes, clean: true };
    }
    // Strictly fewer findings is an improvement. Equal or more means keep the
    // current artifact so a later pass cannot silently regress the lesson.
    if (candidateIssues.length < issues.length) {
      artifact = candidate;
      issues = candidateIssues;
    }
  }

  return { artifact, issues, passes, clean: issues.length === 0 };
}
