import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@/lib/logger';

const log = createLogger('ContinueGenerationStarter');

const PID_FILE = path.join(process.cwd(), 'data', 'continue-jobs', 'worker.pid');
const LOG_FILE = path.join(process.cwd(), 'data', 'continue-jobs', 'worker.log');
const WORKER_SCRIPT = path.join(process.cwd(), 'scripts', 'continue-generation-worker.mjs');

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotently start the detached generation worker. It is a plain Node
 * process (no tsx/Next module graph), so a Next.js restart cannot stop it.
 */
export async function ensureContinueWorker(baseUrl?: string): Promise<number | null> {
  try {
    let existing: number | null = null;
    try {
      existing = JSON.parse(await fs.readFile(PID_FILE, 'utf-8')) as number;
    } catch {
      /* no pid file */
    }
    if (processAlive(existing ?? 0)) return existing;

    await fs.mkdir(path.dirname(PID_FILE), { recursive: true });
    const logHandle = await fs.open(LOG_FILE, 'a');
    const origin = baseUrl ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
    const child = spawn(
      process.execPath,
      [WORKER_SCRIPT, '--base-url', origin],
      {
        cwd: process.cwd(),
        // Detached so the worker survives Next.js restarts. windowsHide keeps
        // that detached child from allocating a visible console window on
        // Windows (CREATE_NO_WINDOW instead of DETACHED_PROCESS).
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logHandle.fd, logHandle.fd],
        env: process.env,
      },
    );
    child.unref();
    await fs.writeFile(PID_FILE, JSON.stringify(child.pid));
    log.info(`Started detached generation worker (pid ${child.pid})`);
    await logHandle.close();
    return child.pid ?? null;
  } catch (error) {
    log.warn('Could not start generation worker:', error);
    return null;
  }
}
