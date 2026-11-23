import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@/lib/logger';

const log = createLogger('ContinueGenerationStarter');

const PID_FILE = path.join(process.cwd(), 'data', 'continue-jobs', 'worker.pid');
const LOG_FILE = path.join(process.cwd(), 'data', 'continue-jobs', 'worker.log');
const WORKER_SCRIPT = path.join(process.cwd(), 'scripts', 'continue-generation-worker.ts');

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
 * Idempotently start the detached generation worker. The worker is a separate
 * OS process, so a Next.js restart (or a dev reload) never interrupts a run.
 */
export async function ensureContinueWorker(): Promise<number | null> {
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
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', WORKER_SCRIPT],
      {
        cwd: process.cwd(),
        detached: true,
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
