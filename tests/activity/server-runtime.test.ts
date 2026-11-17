import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDockerRunArgs,
  resetServerActivityConcurrency,
  runServerActivity,
  type SandboxProcess,
  type SandboxSpawn,
} from '@/lib/activity/server/docker';
import {
  readServerActivityRuntimeConfig,
  type ServerActivityRuntimeConfig,
} from '@/lib/activity/server/config';
import { validateServerActivityRunRequest } from '@/lib/activity/server/request';
import type { ActivityRunRequest } from '@/lib/activity/protocol';

const CONFIG: ServerActivityRuntimeConfig = {
  enabled: true,
  image: 'openmaic/activity-sandbox:test',
  dockerBin: 'docker',
  timeoutMs: 30_000,
  maxConcurrency: 1,
  maxCommands: 10,
  maxCommandChars: 1_000,
  maxFiles: 2,
  maxFileBytes: 100,
  maxOutputChars: 1_000,
};

const RUN: ActivityRunRequest = {
  kind: 'terminal',
  runtime: 'server',
  timeLimitMs: 10_000,
  initialFiles: { 'notes.txt': 'hello\n' },
  commands: ['cat notes.txt'],
};

class FakeProcess implements SandboxProcess {
  stdin: SandboxProcess['stdin'];
  stdout: SandboxProcess['stdout'];
  stderr: SandboxProcess['stderr'];
  readonly kill = vi.fn(() => true);
  readonly written: string[] = [];
  ended = false;
  private stdoutListener?: (chunk: Buffer | string) => void;
  private stderrListener?: (chunk: Buffer | string) => void;
  private closeListener?: (code: number | null) => void;
  private errorListener?: (error: Error) => void;

  constructor() {
    this.stdin = {
      write: (chunk) => this.written.push(chunk),
      end: () => {
        this.ended = true;
      },
    };
    this.stdout = {
      on: (_event, listener) => {
        this.stdoutListener = listener;
      },
    };
    this.stderr = {
      on: (_event, listener) => {
        this.stderrListener = listener;
      },
    };
  }

  on(
    event: 'close' | 'error',
    listener: ((code: number | null) => void) | ((error: Error) => void),
  ): void {
    if (event === 'close') this.closeListener = listener as (code: number | null) => void;
    else this.errorListener = listener as (error: Error) => void;
  }

  emitStdout(text: string): void {
    this.stdoutListener?.(text);
  }

  emitStderr(text: string): void {
    this.stderrListener?.(text);
  }

  close(code: number | null): void {
    this.closeListener?.(code);
  }

  fail(error: Error): void {
    this.errorListener?.(error);
  }
}

function spawnPair(main: FakeProcess) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn: SandboxSpawn = (command, args) => {
    calls.push({ command, args });
    return main;
  };
  return { spawn, calls };
}

beforeEach(() => {
  resetServerActivityConcurrency();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('readServerActivityRuntimeConfig', () => {
  it('stays disabled unless the flag and an image are both set', () => {
    expect(readServerActivityRuntimeConfig({}).enabled).toBe(false);
    expect(
      readServerActivityRuntimeConfig({ ACTIVITY_SERVER_RUNTIME_ENABLED: 'true' }).enabled,
    ).toBe(false);
    expect(
      readServerActivityRuntimeConfig({ ACTIVITY_DOCKER_IMAGE: 'sandbox:latest' }).enabled,
    ).toBe(false);
    expect(
      readServerActivityRuntimeConfig({
        ACTIVITY_SERVER_RUNTIME_ENABLED: 'true',
        ACTIVITY_DOCKER_IMAGE: 'sandbox:latest',
      }).enabled,
    ).toBe(true);
  });

  it('clamps operator-tunable limits', () => {
    const config = readServerActivityRuntimeConfig({
      ACTIVITY_SERVER_RUNTIME_ENABLED: 'true',
      ACTIVITY_DOCKER_IMAGE: 'sandbox',
      ACTIVITY_SERVER_MAX_CONCURRENCY: '999',
      ACTIVITY_SERVER_TIMEOUT_MS: '1',
      ACTIVITY_SERVER_MAX_COMMANDS: '0',
    });
    expect(config.maxConcurrency).toBe(8);
    expect(config.timeoutMs).toBe(5_000);
    expect(config.maxCommands).toBe(1);
  });
});

describe('validateServerActivityRunRequest', () => {
  it('accepts a terminal server request and whitelists its fields', () => {
    const result = validateServerActivityRunRequest({ ...RUN, injected: 'ignored' }, CONFIG);
    expect(result.error).toBeUndefined();
    expect(result.request).toEqual(RUN);
    expect(result.request).not.toHaveProperty('injected');
  });

  it('rejects other kinds and runtimes', () => {
    expect(validateServerActivityRunRequest({ ...RUN, kind: 'code' }, CONFIG).error).toContain(
      'terminal',
    );
    expect(
      validateServerActivityRunRequest({ ...RUN, runtime: 'simulation' }, CONFIG).error,
    ).toContain('runtime');
  });

  it('bounds commands and output-producing inputs', () => {
    expect(
      validateServerActivityRunRequest({ ...RUN, commands: Array(11).fill('pwd') }, CONFIG).error,
    ).toContain('at most 10');
    expect(
      validateServerActivityRunRequest({ ...RUN, commands: ['pwd\0'] }, CONFIG).error,
    ).toContain('NUL');
    expect(
      validateServerActivityRunRequest({ ...RUN, commands: [`echo ${'x'.repeat(2_000)}`] }, CONFIG)
        .error,
    ).toContain('characters');
  });

  it('rejects traversal, absolute and oversized seeded files', () => {
    for (const path of ['../escape', '/etc/passwd', 'a\\b', 'a//b', 'a/../b']) {
      expect(
        validateServerActivityRunRequest({ ...RUN, initialFiles: { [path]: 'x' } }, CONFIG).error,
      ).toContain('Unsafe activity file path');
    }
    expect(
      validateServerActivityRunRequest(
        { ...RUN, initialFiles: { 'a.txt': 'x'.repeat(200) } },
        CONFIG,
      ).error,
    ).toContain('bytes');
  });

  it('clamps the requested time limit', () => {
    expect(
      validateServerActivityRunRequest({ ...RUN, timeLimitMs: 999_999 }, CONFIG).request
        ?.timeLimitMs,
    ).toBe(CONFIG.timeoutMs);
    expect(
      validateServerActivityRunRequest({ ...RUN, timeLimitMs: 10 }, CONFIG).request?.timeLimitMs,
    ).toBe(1_000);
  });
});

describe('buildDockerRunArgs', () => {
  const args = buildDockerRunArgs(CONFIG, 'openmaic-activity-test');
  const joined = args.join(' ');

  it('has no network, no host mounts, no privileges and no credentials', () => {
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '--init']);
    expect(joined).toContain('--network none');
    expect(joined).toContain('--read-only');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('--security-opt no-new-privileges');
    expect(joined).toContain('--user 1000:1000');
    expect(joined).toContain('--pull never');
    expect(joined).not.toContain('--volume');
    expect(joined).not.toContain(' -v ');
    expect(joined).not.toContain('--privileged');
    expect(joined).not.toContain('--network host');
    expect(joined).not.toContain('--env-file');
    expect(args.at(-1)).toBe(CONFIG.image);
  });

  it('forwards only fixed container environment values', () => {
    expect(joined).toContain('HOME=/home/learner');
    expect(joined).toContain('PATH=/usr/local/bin:/usr/bin:/bin');
    expect(joined).not.toContain('OPENAI_API_KEY');
    expect(joined).not.toContain('DATABASE_URL');
  });

  it('writes the workspace to an ephemeral tmpfs', () => {
    expect(joined).toContain('/home/learner:rw,noexec,nosuid,size=32m,mode=0700');
    expect(joined).toContain('/tmp:rw,noexec,nosuid,size=16m');
  });
});

describe('runServerActivity', () => {
  it('returns a parsed sandbox result', async () => {
    const process = new FakeProcess();
    const { spawn, calls } = spawnPair(process);
    const promise = runServerActivity(RUN, CONFIG, { spawn });
    expect(calls[0]?.args).toContain('none');
    expect(JSON.parse(process.written[0] ?? '{}')).toMatchObject({
      commands: ['cat notes.txt'],
      initialFiles: { 'notes.txt': 'hello\n' },
    });
    process.emitStdout(
      JSON.stringify({
        status: 'ok',
        stdout: 'hello\n',
        stderr: '',
        exitCode: 0,
        files: { 'notes.txt': 'hello\n' },
        state: { cwd: '/home/learner' },
      }),
    );
    process.close(0);
    await expect(promise).resolves.toMatchObject({
      result: { status: 'ok', stdout: 'hello\n' },
    });
    expect(resetServerActivityConcurrency).toBeTypeOf('function');
  });

  it('rejects a malformed sandbox result instead of inventing one', async () => {
    const process = new FakeProcess();
    const promise = runServerActivity(RUN, CONFIG, { spawn: spawnPair(process).spawn });
    process.emitStdout('not json');
    process.close(0);
    await expect(promise).resolves.toMatchObject({
      result: { status: 'error' },
    });
  });

  it('kills and removes the container on timeout', async () => {
    vi.useFakeTimers();
    const process = new FakeProcess();
    const { spawn, calls } = spawnPair(process);
    const promise = runServerActivity({ ...RUN, timeLimitMs: 5_000 }, CONFIG, { spawn });
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(promise).resolves.toMatchObject({
      result: { status: 'timeout' },
    });
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
    expect(calls.some((call) => call.args[0] === 'rm' && call.args[1] === '-f')).toBe(true);
  });

  it('caps captured output', async () => {
    const process = new FakeProcess();
    const promise = runServerActivity(RUN, CONFIG, { spawn: spawnPair(process).spawn });
    process.emitStdout('x'.repeat(1_001));
    await expect(promise).resolves.toMatchObject({
      result: { status: 'error' },
    });
    expect(process.kill).toHaveBeenCalled();
  });

  it('reports capacity instead of queueing unbounded containers', async () => {
    const process = new FakeProcess();
    const { spawn } = spawnPair(process);
    const first = runServerActivity(RUN, CONFIG, { spawn });
    await expect(runServerActivity(RUN, CONFIG, { spawn })).resolves.toEqual({ busy: true });
    process.close(0);
    await first;
  });

  it('refuses a non-server request', async () => {
    const process = new FakeProcess();
    await expect(
      runServerActivity({ ...RUN, runtime: 'simulation' }, CONFIG, {
        spawn: spawnPair(process).spawn,
      }),
    ).resolves.toMatchObject({ result: { status: 'error' } });
  });
});
