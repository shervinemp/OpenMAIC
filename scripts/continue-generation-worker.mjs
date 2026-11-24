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
const POLL_MS = 5_000;
const STALL_MS = 45 * 60_000;
const MAX_STATUS_FAILURES = 12;
const WORKER_ID = `${process.pid}-${Date.now()}`;

const inFlight = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    // Lease freshness is the heartbeat's mtime, not the original claim time:
    // claimedAt never changes, so a live run would go stale after LEASE_MS.
    const stat = await fs.stat(file);
    stale = now - stat.mtimeMs > LEASE_MS;
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

async function readJob(id) {
  const response = await fetch(`${baseUrl}/api/generation/continue/${id}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`status returned ${response.status}`);
  const payload = await response.json();
  return payload.job ?? payload.data?.job ?? null;
}

async function runOne(id) {
  inFlight.add(id);
  const heartbeat = setInterval(() => {
    void fs.utimes(lockPath(id), new Date(), new Date()).catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  let progressKey = '';
  let lastProgress = Date.now();
  let failures = 0;
  let stalled = false;
  try {
    await dispatch(id);
    // The /execute response only acknowledges the dispatch: the scene loop is
    // detached and runs for hours. Hold the lease until the job settles, or a
    // 60s lease expiry makes this worker re-dispatch the same job repeatedly.
    for (;;) {
      await sleep(POLL_MS);
      let job;
      try {
        job = await readJob(id);
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= MAX_STATUS_FAILURES) throw error;
        continue;
      }
      if (!job || (job.status !== 'queued' && job.status !== 'running')) break;
      const key = `${job.scenesGenerated}/${job.scenesFailed}`;
      if (key !== progressKey) {
        progressKey = key;
        lastProgress = Date.now();
      }
      if (Date.now() - lastProgress > STALL_MS) {
        stalled = true;
        break;
      }
    }
  } catch (error) {
    console.error(`[continue-worker] ${id}:`, error.message);
  } finally {
    clearInterval(heartbeat);
    await fs.rm(lockPath(id), { force: true }).catch(() => undefined);
    inFlight.delete(id);
    if (stalled) console.error(`[continue-worker] ${id}: stalled, lease released for re-dispatch`);
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
// Keep this interval REFERENCED: an unref'd timer lets Node exit as soon as a
// dispatched job settles, which would kill the coordinator between scans.
setInterval(() => void scan(), SCAN_MS);
process.on('SIGTERM', () => process.exit(0));
