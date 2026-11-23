/**
 * Detached generation worker (plain Node, no bundler).
 *
 * Coordinates durable jobs through lock files and the app's HTTP API. It owns
 * no LLM work itself, so it survives Next.js restarts: a job killed with the
 * old process loses its lease, and this worker re-dispatches it to the new one.
 * Scene-by-scene commits mean the resume picks up where it left off.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jobsDir = process.env.CONTINUE_JOBS_DIR
  ? path.resolve(process.env.CONTINUE_JOBS_DIR)
  : path.join(root, 'data', 'continue-jobs');
const baseUrlArg = process.argv.indexOf('--base-url');
const baseUrl =
  baseUrlArg >= 0 ? process.argv[baseUrlArg + 1] : `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const LEASE_MS = 60_000;
const HEARTBEAT_MS = 20_000;
const SCAN_MS = 2_000;
const WORKER_ID = `${process.pid}-${Date.now()}`;

const inFlight = new Set();

function lockPath(id) {
  return path.join(jobsDir, `${id}.lock`);
}

async function tryClaim(id) {
  const file = lockPath(id);
  const now = Date.now();
  try {
    const handle = await fs.open(file, 'wx');
    await handle.writeFile(JSON.stringify({ workerId: WORKER_ID, claimedAt: now }));
    await handle.close();
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let stale = true;
  try {
    const owner = JSON.parse(await fs.readFile(file, 'utf-8'));
    const claimedAt = owner.claimedAt ?? 0;
    stale = now - claimedAt > LEASE_MS;
  } catch {
    stale = true;
  }
  if (!stale) return false;
  await fs.rm(file, { force: true });
  return tryClaim(id);
}

async function dispatch(id) {
  const response = await fetch(`${baseUrl}/api/generation/continue/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: id }),
  });
  if (!response.ok) throw new Error(`execute returned ${response.status}`);
}

async function runOne(id) {
  inFlight.add(id);
  const heartbeat = setInterval(() => {
    void fs.utimes(lockPath(id), new Date(), new Date()).catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    await dispatch(id);
  } catch (error) {
    console.error(`[continue-worker] ${id}:`, error.message);
    // A job the new process never accepted must be given back.
    await fs.rm(lockPath(id), { force: true }).catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
    inFlight.delete(id);
  }
}

async function scan() {
  try {
    const names = await fs.readdir(jobsDir);
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.input.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (inFlight.has(id)) continue;
      const job = JSON.parse(await fs.readFile(path.join(jobsDir, name), 'utf-8'));
      if (job.status !== 'queued' && job.status !== 'running') continue;
      if (!(await tryClaim(id))) continue;
      void runOne(id);
    }
  } catch (error) {
    console.error('[continue-worker] scan:', error.message);
  }
}

console.log(`[continue-worker] ${WORKER_ID} ready (${baseUrl})`);
void scan();
setInterval(() => void scan(), SCAN_MS).unref?.();
process.on('SIGTERM', () => process.exit(0));
