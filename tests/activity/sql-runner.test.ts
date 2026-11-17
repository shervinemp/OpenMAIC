import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlActivityRunner, createSqlActivityRunner } from '@/lib/activity/sql-runner';
import type { ActivityWorker } from '@/lib/activity/worker-runner';
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
    kind: 'sql',
    timeLimitMs: 5000,
    setupSql: 'create table t (n int);',
    submissionSql: 'insert into t values (1);',
    sqlProbes: [{ id: 'rows', sql: 'select n from t;' }],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SqlActivityRunner', () => {
  it('creates a runner through the factory', () => {
    expect(createSqlActivityRunner()).toBeInstanceOf(SqlActivityRunner);
  });

  it('resolves a SQL result reported after the engine starts', async () => {
    const worker = new FakeWorker();
    const runner = new SqlActivityRunner({ createWorker: () => worker });
    const promise = runner.run(request());
    const message = worker.sent[0] as { runId: string };
    worker.emit({ type: 'started', runId: message.runId });
    worker.emit({
      type: 'result',
      runId: message.runId,
      result: {
        status: 'ok',
        stdout: '',
        stderr: '',
        sqlProbes: { rows: { columns: ['n'], rows: [[1]] } },
        durationMs: 2,
      },
    });
    await expect(promise).resolves.toMatchObject({
      status: 'ok',
      sqlProbes: { rows: { rows: [[1]] } },
    });
  });

  it('refuses a code request instead of running it in Postgres', async () => {
    const runner = new SqlActivityRunner({ createWorker: () => new FakeWorker() });
    await expect(
      runner.run({ kind: 'code', timeLimitMs: 5000, files: {}, entryFile: 'main.py' }),
    ).resolves.toMatchObject({ status: 'error' });
  });

  it('kills the engine when a run exceeds its limit', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const runner = new SqlActivityRunner({ createWorker: () => worker, initTimeoutMs: 60_000 });
    const promise = runner.run(request({ timeLimitMs: 1000 }));
    const message = worker.sent[0] as { runId: string };
    worker.emit({ type: 'started', runId: message.runId });
    await vi.advanceTimersByTimeAsync(1001);
    await expect(promise).resolves.toMatchObject({ status: 'timeout' });
    expect(worker.terminated).toBe(true);
  });

  it('abandons an engine that never starts', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const runner = new SqlActivityRunner({ createWorker: () => worker, initTimeoutMs: 500 });
    const promise = runner.run(request());
    await vi.advanceTimersByTimeAsync(501);
    await expect(promise).resolves.toMatchObject({ status: 'error' });
    expect(worker.terminated).toBe(true);
  });

  it('reports an engine error without inventing a result', async () => {
    const worker = new FakeWorker();
    const runner = new SqlActivityRunner({ createWorker: () => worker });
    const promise = runner.run(request());
    const message = worker.sent[0] as { runId: string };
    worker.emit({ type: 'started', runId: message.runId });
    worker.emit({ type: 'error', runId: message.runId, message: 'wasm failed to load' });
    await expect(promise).resolves.toMatchObject({
      status: 'error',
      error: 'wasm failed to load',
    });
    expect(worker.terminated).toBe(true);
  });
});
