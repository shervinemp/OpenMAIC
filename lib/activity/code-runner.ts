/**
 * Python code-lab runner.
 *
 * Thin specialization of the shared worker controller; the Pyodide protocol
 * itself lives in `public/vendor/activity/python-worker.js`.
 */
import type { ActivityRunner, ActivityWorker } from './worker-runner';
import { DEFAULT_INIT_TIMEOUT_MS, WorkerActivityRunner } from './worker-runner';

export type { ActivityRunner, ActivityWorker } from './worker-runner';
export { DEFAULT_INIT_TIMEOUT_MS } from './worker-runner';

export interface PythonCodeRunnerOptions {
  createWorker?: () => ActivityWorker;
  /** Time allowed for interpreter start-up before the worker is abandoned. */
  initTimeoutMs?: number;
}

export const DEFAULT_WORKER_URL = '/vendor/activity/python-worker.js';

const PYTHON_LANGUAGES = new Set(['python', 'python3', 'py']);

export function isPythonLanguage(language: string | undefined): boolean {
  return typeof language === 'string' && PYTHON_LANGUAGES.has(language.trim().toLowerCase());
}

export class PythonCodeRunner extends WorkerActivityRunner {
  constructor(options: PythonCodeRunnerOptions = {}) {
    super({
      workerUrl: DEFAULT_WORKER_URL,
      expectedKind: 'code',
      runtimeLabel: 'Python',
      createWorker: options.createWorker,
      initTimeoutMs: options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
    });
  }
}

/** Create the Python runner used by the code-lab view. */
export function createPythonCodeRunner(options?: PythonCodeRunnerOptions): ActivityRunner {
  return new PythonCodeRunner(options);
}
