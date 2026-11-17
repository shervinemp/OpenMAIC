/**
 * Client runner for the operator-gated server terminal tier.
 *
 * It forwards exactly the runner request and treats every transport or server
 * failure as `status: 'error'` — the evaluator then leaves checks ungraded
 * rather than blaming the learner for a harness problem.
 */
import type { ActivityRunRequest, ActivityRunResult } from './protocol';
import type { ActivityRunner } from './worker-runner';

function failure(message: string): ActivityRunResult {
  return { status: 'error', stdout: '', stderr: '', error: message, durationMs: 0 };
}

export class ServerTerminalRunner implements ActivityRunner {
  private disposed = false;

  async run(request: ActivityRunRequest): Promise<ActivityRunResult> {
    if (this.disposed) return failure('The server runner was disposed.');
    if (request.kind !== 'terminal' || request.runtime !== 'server') {
      return failure('This runner only executes server terminal activities.');
    }
    try {
      const response = await fetch('/api/activity/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = (await response.json().catch(() => null)) as {
        success?: boolean;
        result?: ActivityRunResult;
        error?: string;
        errorCode?: string;
      } | null;
      if (!response.ok || !body?.success) {
        return failure(
          body?.error || `The server runtime rejected the request (HTTP ${response.status}).`,
        );
      }
      if (!body.result || typeof body.result.status !== 'string') {
        return failure('The server runtime returned no usable result.');
      }
      return body.result;
    } catch (error) {
      return failure(
        `The server runtime could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}

export function createServerTerminalRunner(): ActivityRunner {
  return new ServerTerminalRunner();
}
