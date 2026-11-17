/**
 * Code-lab runner controller.
 *
 * Owns one Python worker across attempts so the Pyodide interpreter is paid
 * for once per lab. A run that exceeds its limit terminates the worker — a
 * busy WebAssembly loop cannot be interrupted from the main thread — and the
 * next attempt starts a fresh one. Interpreter start-up is reported separately
 * by the worker, so the learner's time limit never covers it.
 */
import type { ActivityRunRequest, ActivityRunResult } from './protocol';

export interface ActivityRunner {
  run(request: ActivityRunRequest): Promise<ActivityRunResult>;
  dispose(): void;
}

/** The slice of the DOM Worker the controller uses; injectable for tests. */
export interface ActivityWorker {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  onmessageerror?: ((event: { message?: string }) => void) | null;
}

export interface PythonCodeRunnerOptions {
  createWorker?: () => ActivityWorker;
  /** Time allowed for interpreter start-up before the worker is abandoned. */
  initTimeoutMs?: number;
}

export const DEFAULT_WORKER_URL = '/vendor/activity/python-worker.js';
export const DEFAULT_INIT_TIMEOUT_MS = 60_000;

const PYTHON_LANGUAGES = new Set(['python', 'python3', 'py']);

export function isPythonLanguage(language: string | undefined): boolean {
  return typeof language === 'string' && PYTHON_LANGUAGES.has(language.trim().toLowerCase());
}

interface WorkerReply {
  type?: string;
  runId?: string;
  result?: ActivityRunResult;
  message?: string;
}

interface PendingRun {
  runId: string;
  resolve: (result: ActivityRunResult) => void;
  timer: ReturnType<typeof setTimeout>;
  started: boolean;
  timeLimitMs: number;
}

function harnessFailure(message: string, status: 'error' | 'timeout'): ActivityRunResult {
  return {
    status,
    stdout: '',
    stderr: '',
    error: message,
    durationMs: 0,
  };
}

function defaultWorkerFactory(): ActivityWorker {
  if (typeof Worker === 'undefined') {
    throw new Error('Web Workers are not available in this environment.');
  }
  return new Worker(DEFAULT_WORKER_URL, { type: 'module' }) as unknown as ActivityWorker;
}

export class PythonCodeRunner implements ActivityRunner {
  private readonly createWorker: () => ActivityWorker;
  private readonly initTimeoutMs: number;
  private worker: ActivityWorker | null = null;
  private pending: PendingRun | null = null;
  private sequence = 0;
  private disposed = false;

  constructor(options: PythonCodeRunnerOptions = {}) {
    this.createWorker = options.createWorker ?? defaultWorkerFactory;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  }

  run(request: ActivityRunRequest): Promise<ActivityRunResult> {
    if (this.disposed) {
      return Promise.resolve(harnessFailure('The code runner was disposed.', 'error'));
    }
    if (request.kind !== 'code') {
      return Promise.resolve(harnessFailure('This runner only executes code activities.', 'error'));
    }
    if (this.pending) {
      return Promise.resolve(harnessFailure('Another run is already in progress.', 'error'));
    }

    let worker: ActivityWorker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.resolve(
        harnessFailure(
          error instanceof Error ? error.message : 'The code runner could not start.',
          'error',
        ),
      );
    }

    this.sequence += 1;
    const runId = `run-${this.sequence}`;
    return new Promise<ActivityRunResult>((resolve) => {
      const pending: PendingRun = {
        runId,
        resolve: (result) => {
          this.settle(pending);
          resolve(result);
        },
        timer: setTimeout(() => {
          this.abandon(pending, 'error', 'The Python runtime did not start in time.');
        }, this.initTimeoutMs),
        started: false,
        timeLimitMs: request.timeLimitMs,
      };
      this.pending = pending;
      worker.postMessage({ type: 'run', runId, request });
    });
  }

  dispose(): void {
    this.disposed = true;
    const pending = this.pending;
    if (pending) {
      pending.resolve(harnessFailure('The code runner was disposed.', 'error'));
    }
    this.terminateWorker();
  }

  private ensureWorker(): ActivityWorker {
    if (!this.worker) {
      const worker = this.createWorker();
      worker.onmessage = (event) => this.handleMessage(event.data);
      worker.onerror = (event) => {
        this.pending?.resolve(
          harnessFailure(event.message || 'The Python runtime failed to load.', 'error'),
        );
        this.terminateWorker();
      };
      if ('onmessageerror' in worker) {
        worker.onmessageerror = () => {
          this.pending?.resolve(
            harnessFailure('The Python runtime sent an unreadable message.', 'error'),
          );
          this.terminateWorker();
        };
      }
      this.worker = worker;
    }
    return this.worker;
  }

  private handleMessage(data: unknown): void {
    const reply = data as WorkerReply | null;
    const pending = this.pending;
    if (!reply || !pending || reply.runId !== pending.runId) return;

    if (reply.type === 'started') {
      if (pending.started) return;
      pending.started = true;
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        this.abandon(pending, 'timeout', 'The run exceeded its time limit.');
      }, pending.timeLimitMs);
      return;
    }

    if (reply.type === 'result') {
      pending.resolve(reply.result ?? harnessFailure('The runner returned no result.', 'error'));
      return;
    }

    if (reply.type === 'error') {
      pending.resolve(harnessFailure(reply.message || 'The Python runtime failed.', 'error'));
      this.terminateWorker();
    }
  }

  private abandon(pending: PendingRun, status: 'error' | 'timeout', message: string): void {
    pending.resolve(harnessFailure(message, status));
    // A timed-out interpreter is still running the learner's loop; kill it so
    // the next attempt gets a clean process.
    this.terminateWorker();
  }

  private settle(pending: PendingRun): void {
    clearTimeout(pending.timer);
    if (this.pending === pending) this.pending = null;
  }

  private terminateWorker(): void {
    if (this.worker) {
      const worker = this.worker;
      this.worker = null;
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
    }
  }
}

/** Create the Python runner used by the code-lab view. */
export function createPythonCodeRunner(options?: PythonCodeRunnerOptions): ActivityRunner {
  return new PythonCodeRunner(options);
}
