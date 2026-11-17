import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INIT_TIMEOUT_MS,
  PythonCodeRunner,
  isPythonLanguage,
  type ActivityWorker,
} from '@/lib/activity/code-runner';
import type { ActivityRunRequest } from '@/lib/activity/protocol';

class FakeWorker implements ActivityWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  onmessageerror: ((event: { message?: string }) => void) | null = null;
  readonly sent: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

function request(overrides: Partial<ActivityRunRequest> = {}): ActivityRunRequest {
  return {
    kind: 'code',
    timeLimitMs: 5000,
    files: { 'main.py': 'print(1)' },
    entryFile: 'main.py',
    tests: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PythonCodeRunner', () => {
  it('accepts Python language aliases only', () => {
    expect(isPythonLanguage('python')).toBe(true);
    expect(isPythonLanguage('Python3')).toBe(true);
    expect(isPythonLanguage('py')).toBe(true);
    expect(isPythonLanguage('javascript')).toBe(false);
    expect(isPythonLanguage(undefined)).toBe(false);
  });

  it('resolves a result reported after the worker starts', async () => {
    const worker = new FakeWorker();
    const runner = new PythonCodeRunner({ createWorker: () => worker, initTimeoutMs: 10_000 });
    const promise = runner.run(request());
    const message = worker.sent[0] as { runId: string };
    worker.emit({ type: 'started', runId: message.runId });
    worker.emit({
      type: 'result',
      runId: message.runId,
      result: { status: 'ok', stdout: '1\n', stderr: '', durationMs: 3 },
    });
    await expect(promise).resolves.toMatchObject({ status: 'ok', stdout: '1\n' });
  });

  it('bills the time limit only after the runner starts', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const runner = new PythonCodeRunner({ createWorker: () => worker, initTimeoutMs: 60_000 });
    const promise = runner.run(request({ timeLimitMs: 5000 }));
    const message = worker.sent[0] as { runId: string };

    // Init time does not consume the learner's limit.
    await vi.advanceTimersByTimeAsync(4000);
    worker.emit({ type: 'started', runId: message.runId });
    await vi.advanceTimersByTimeAsync(4999);
    expect(worker.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    await expect(promise).resolves.toMatchObject({ status: 'timeout' });
    expect(worker.terminated).toBe(true);
  });

  it('abandons a worker that never starts', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const runner = new PythonCodeRunner({ createWorker: () => worker, initTimeoutMs: 1000 });
    const promise = runner.run(request());
    await vi.advanceTimersByTimeAsync(1001);
    await expect(promise).resolves.toMatchObject({ status: 'error' });
    expect(worker.terminated).toBe(true);
  });

  it('reports a worker error without inventing a result', async () => {
    const worker = new FakeWorker();
    const runner = new PythonCodeRunner({ createWorker: () => worker });
    const promise = runner.run(request());
    const message = worker.sent[0] as { runId: string };
    worker.emit({ type: 'started', runId: message.runId });
    worker.emit({ type: 'error', runId: message.runId, message: 'engine exploded' });
    await expect(promise).resolves.toMatchObject({
      status: 'error',
      error: 'engine exploded',
    });
    expect(worker.terminated).toBe(true);
  });

  it('starts a fresh worker after a timeout', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const runner = new PythonCodeRunner({
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      initTimeoutMs: 60_000,
    });
    const first = runner.run(request({ timeLimitMs: 1000 }));
    const firstMessage = workers[0].sent[0] as { runId: string };
    workers[0].emit({ type: 'started', runId: firstMessage.runId });
    await vi.advanceTimersByTimeAsync(1001);
    await expect(first).resolves.toMatchObject({ status: 'timeout' });

    const second = runner.run(request({ timeLimitMs: 1000 }));
    expect(workers).toHaveLength(2);
    const secondMessage = workers[1].sent[0] as { runId: string };
    workers[1].emit({
      type: 'result',
      runId: secondMessage.runId,
      result: { status: 'ok', stdout: '', stderr: '', durationMs: 1 },
    });
    await expect(second).resolves.toMatchObject({ status: 'ok' });
  });

  it('rejects concurrent runs instead of mixing responses', async () => {
    const worker = new FakeWorker();
    const runner = new PythonCodeRunner({ createWorker: () => worker });
    const first = runner.run(request());
    await expect(runner.run(request())).resolves.toMatchObject({ status: 'error' });
    const message = worker.sent[0] as { runId: string };
    worker.emit({
      type: 'result',
      runId: message.runId,
      result: { status: 'ok', stdout: '', stderr: '', durationMs: 1 },
    });
    await expect(first).resolves.toMatchObject({ status: 'ok' });
  });

  it('refuses non-code requests', async () => {
    const runner = new PythonCodeRunner({ createWorker: () => new FakeWorker() });
    await expect(
      runner.run({ kind: 'sql', timeLimitMs: 5000, submissionSql: 'select 1' }),
    ).resolves.toMatchObject({ status: 'error' });
  });

  it('disposes the worker and resolves a pending run', async () => {
    const worker = new FakeWorker();
    const runner = new PythonCodeRunner({ createWorker: () => worker });
    const promise = runner.run(request());
    runner.dispose();
    await expect(promise).resolves.toMatchObject({ status: 'error' });
    expect(worker.terminated).toBe(true);
    await expect(runner.run(request())).resolves.toMatchObject({ status: 'error' });
  });

  it('never bills the default init timeout to a started run', () => {
    expect(DEFAULT_INIT_TIMEOUT_MS).toBeGreaterThan(10_000);
  });
});
