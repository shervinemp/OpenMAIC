/**
 * Docker executor for the operator-gated server activity runtime.
 *
 * SECURITY BOUNDARY: this is the only place the app starts a process that can
 * run learner-authored commands. The container is created with:
 *   - no host network (`--network none`),
 *   - no host mounts (no `--volume`),
 *   - a read-only root filesystem with two ephemeral tmpfs mounts,
 *   - all Linux capabilities dropped and `no-new-privileges`,
 *   - a non-root UID, PID/memory/CPU/file-descriptor limits,
 *   - no host environment forwarded (only fixed HOME/PATH/USER/LANG),
 *   - `--pull never`, so the request cannot cause a registry fetch.
 * It is never invoked unless the operator enables the tier and names the image.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ActivityRunRequest, ActivityRunResult } from '../protocol';
import type { ServerActivityRuntimeConfig } from './config';

export interface SandboxProcess {
  stdin: { write(chunk: string): void; end(): void } | null;
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  on(event: 'close', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SandboxSpawn = (
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined>; stdio: ['pipe', 'pipe', 'pipe'] },
) => SandboxProcess;

export interface ServerRunDependencies {
  spawn?: SandboxSpawn;
  /** Test seam: bypass the process-wide concurrency counter. */
  skipConcurrency?: boolean;
}

export interface ServerRunOutcome {
  result?: ActivityRunResult;
  busy?: boolean;
}

let activeRuns = 0;

/** Test-only: reset the process-wide concurrency counter. */
export function resetServerActivityConcurrency(): void {
  activeRuns = 0;
}

export function buildDockerRunArgs(
  config: ServerActivityRuntimeConfig,
  containerName: string,
): string[] {
  return [
    'run',
    '--rm',
    '--init',
    '--interactive',
    '--name',
    containerName,
    '--pull',
    'never',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '1000:1000',
    '--workdir',
    '/home/learner',
    '--memory',
    '256m',
    '--memory-swap',
    '256m',
    '--cpus',
    '0.5',
    '--pids-limit',
    '64',
    '--ulimit',
    'nofile=256:256',
    '--tmpfs',
    '/home/learner:rw,noexec,nosuid,size=32m,mode=0700',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '--env',
    'HOME=/home/learner',
    '--env',
    'PATH=/usr/local/bin:/usr/bin:/bin',
    '--env',
    'USER=learner',
    '--env',
    'LANG=C.UTF-8',
    '--label',
    'openmaic.activity=1',
    config.image,
  ];
}

/** Only the daemon-routing variables the Docker CLI itself needs. */
function dockerCliEnv(): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    DOCKER_TLS_VERIFY: process.env.DOCKER_TLS_VERIFY,
    DOCKER_CERT_PATH: process.env.DOCKER_CERT_PATH,
  };
}

function defaultSpawn(
  command: string,
  args: string[],
  options: Parameters<SandboxSpawn>[2],
): SandboxProcess {
  return nodeSpawn(command, args, {
    env: options.env as NodeJS.ProcessEnv,
    stdio: options.stdio,
  }) as unknown as SandboxProcess;
}

function timeoutResult(message: string): ActivityRunResult {
  return { status: 'timeout', stdout: '', stderr: '', error: message, durationMs: 0 };
}

function errorResult(message: string): ActivityRunResult {
  return { status: 'error', stdout: '', stderr: '', error: message, durationMs: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return null;
    record[key] = entry;
  }
  return record;
}

function normalizeResult(value: unknown, durationMs: number): ActivityRunResult | null {
  if (!isRecord(value)) return null;
  if (value.status !== 'ok' && value.status !== 'error' && value.status !== 'timeout') {
    return null;
  }
  const stdout = typeof value.stdout === 'string' ? value.stdout : '';
  const stderr = typeof value.stderr === 'string' ? value.stderr : '';
  const files = stringRecord(value.files);
  const state = stringRecord(value.state);
  if (files === null || state === null) return null;
  return {
    status: value.status,
    stdout,
    stderr,
    ...(typeof value.exitCode === 'number' || value.exitCode === null
      ? { exitCode: value.exitCode as number | null }
      : {}),
    files,
    state,
    ...(typeof value.error === 'string' && value.error ? { error: value.error } : {}),
    durationMs,
  };
}

async function removeContainer(
  config: ServerActivityRuntimeConfig,
  name: string,
  spawn: SandboxSpawn,
): Promise<void> {
  try {
    const child = spawn(config.dockerBin, ['rm', '-f', name], {
      env: dockerCliEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin?.end();
    child.on('error', () => {});
  } catch {
    /* the daemon may already have removed it */
  }
}

/**
 * Run one session in a disposable container. Resolves exactly once; every
 * failure mode is a `status: 'error' | 'timeout'` result, never a synthesized
 * pass.
 */
export async function runServerActivity(
  request: ActivityRunRequest,
  config: ServerActivityRuntimeConfig,
  deps: ServerRunDependencies = {},
): Promise<ServerRunOutcome> {
  if (!config.enabled || !config.image) {
    return { result: errorResult('The server activity runtime is not enabled.') };
  }
  if (request.kind !== 'terminal' || request.runtime !== 'server') {
    return { result: errorResult('The server runtime only executes terminal activities.') };
  }
  if (!deps.skipConcurrency && activeRuns >= config.maxConcurrency) {
    return { busy: true };
  }

  const spawn = deps.spawn ?? defaultSpawn;
  const containerName = `openmaic-activity-${randomUUID()}`;
  const started = Date.now();
  if (!deps.skipConcurrency) activeRuns += 1;

  return new Promise<ServerRunOutcome>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: SandboxProcess | undefined;

    const finish = (outcome: ServerRunOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!deps.skipConcurrency) activeRuns = Math.max(0, activeRuns - 1);
      resolve(outcome);
    };

    const failAfterKill = (result: ActivityRunResult) => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      void removeContainer(config, containerName, spawn);
      finish({ result });
    };

    try {
      child = spawn(config.dockerBin, buildDockerRunArgs(config, containerName), {
        env: dockerCliEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        result: errorResult(
          `Could not start the sandbox runtime: ${error instanceof Error ? error.message : String(error)}`,
        ),
      });
      return;
    }

    child.on('error', (error) => {
      finish({ result: errorResult(`The sandbox runtime could not start: ${error.message}`) });
    });

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length + stderr.length > config.maxOutputChars) {
        failAfterKill(
          errorResult(
            `The sandbox produced more than ${config.maxOutputChars} characters of output.`,
          ),
        );
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stdout.length + stderr.length > config.maxOutputChars) {
        failAfterKill(
          errorResult(
            `The sandbox produced more than ${config.maxOutputChars} characters of output.`,
          ),
        );
      }
    });

    timer = setTimeout(() => {
      failAfterKill(timeoutResult('The sandboxed session exceeded its time limit.'));
    }, request.timeLimitMs);

    child.on('close', (code) => {
      if (settled) return;
      const durationMs = Date.now() - started;
      if (code !== 0 && stdout.trim() === '') {
        finish({
          result: errorResult(
            `The sandbox exited with code ${code ?? 'null'}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : '.'}`,
          ),
        });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        finish({
          result: errorResult(
            `The sandbox returned an unreadable result${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : '.'}`,
          ),
        });
        return;
      }
      const normalized = normalizeResult(parsed, durationMs);
      if (!normalized) {
        finish({ result: errorResult('The sandbox returned a malformed result.') });
        return;
      }
      finish({ result: normalized });
    });

    try {
      child.stdin?.write(
        JSON.stringify({
          initialFiles: request.initialFiles ?? {},
          commands: request.commands ?? [],
        }),
      );
      child.stdin?.end();
    } catch (error) {
      failAfterKill(
        errorResult(
          `Could not send the session to the sandbox: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  });
}
