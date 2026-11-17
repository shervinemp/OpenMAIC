/**
 * Terminal-lab runner: an in-process deterministic shell.
 *
 * No worker is involved because the simulation is synchronous and cannot run
 * arbitrary code. The operator-gated server isolation tier is the only place
 * real commands execute.
 */
import type { ActivityRunRequest, ActivityRunResult } from './protocol';
import { simulateTerminal } from './terminal-simulator';
import type { ActivityRunner } from './worker-runner';

export class TerminalRunner implements ActivityRunner {
  run(request: ActivityRunRequest): Promise<ActivityRunResult> {
    if (request.kind !== 'terminal') {
      return Promise.resolve({
        status: 'error',
        stdout: '',
        stderr: '',
        error: 'This runner only executes terminal activities.',
        durationMs: 0,
      });
    }
    return Promise.resolve(
      simulateTerminal({
        initialFiles: request.initialFiles,
        commands: request.commands,
      }),
    );
  }

  dispose(): void {
    /* stateless */
  }
}

export function createTerminalRunner(): ActivityRunner {
  return new TerminalRunner();
}
