/**
 * SQL lab runner.
 *
 * Thin specialization of the shared worker controller; the PGlite protocol
 * itself lives in `public/vendor/activity/sql-worker.js`.
 */
import type { ActivityRunner, ActivityWorker } from './worker-runner';
import { DEFAULT_INIT_TIMEOUT_MS, WorkerActivityRunner } from './worker-runner';

export interface SqlActivityRunnerOptions {
  createWorker?: () => ActivityWorker;
  /** Time allowed for engine start-up before the worker is abandoned. */
  initTimeoutMs?: number;
}

export const DEFAULT_SQL_WORKER_URL = '/vendor/activity/sql-worker.js';

export class SqlActivityRunner extends WorkerActivityRunner {
  constructor(options: SqlActivityRunnerOptions = {}) {
    super({
      workerUrl: DEFAULT_SQL_WORKER_URL,
      expectedKind: 'sql',
      runtimeLabel: 'SQL',
      createWorker: options.createWorker,
      initTimeoutMs: options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
    });
  }
}

/** Create the SQL runner used by the SQL-lab view. */
export function createSqlActivityRunner(options?: SqlActivityRunnerOptions): ActivityRunner {
  return new SqlActivityRunner(options);
}
