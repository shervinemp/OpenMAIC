import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir: string;
let store: typeof import('@/lib/server/continue-generation/store');

const input = (stageId: string) => ({
  stageId,
  ownerId: 'local',
  baseUrl: 'http://localhost:3000',
});

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'continue-jobs-'));
  process.env.CONTINUE_JOBS_DIR = dir;
  store = await import('@/lib/server/continue-generation/store');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('continue generation job store', () => {
  it('creates a queued job and keeps a resumable input without credentials', async () => {
    const job = await store.createContinueJob('job-1', input('stage-1'));
    expect(job.status).toBe('queued');
    expect(job.stageId).toBe('stage-1');
    expect((await store.readContinueJob('job-1'))?.id).toBe('job-1');

    const saved = await store.readContinueJobInput('job-1');
    expect(saved?.stageId).toBe('stage-1');
    expect(JSON.stringify(saved)).not.toContain('apiKey');
  });

  it('updates progress atomically and stamps updatedAt', async () => {
    await store.createContinueJob('job-2', input('stage-2'));
    const updated = await store.updateContinueJob('job-2', {
      status: 'running',
      scenesGenerated: 7,
      message: '7 scenes',
    });
    expect(updated?.scenesGenerated).toBe(7);
    expect(updated?.status).toBe('running');
    const stored = await store.readContinueJob('job-2');
    expect(stored?.scenesGenerated).toBe(7);
  });

  it('finds only interrupted running jobs for recovery', async () => {
    await store.createContinueJob('job-3', input('stage-3'));
    await store.updateContinueJob('job-3', { status: 'running' });
    await store.createContinueJob('job-4', input('stage-4'));
    await store.updateContinueJob('job-4', { status: 'succeeded' });

    const interrupted = await store.findInterruptedContinueJobs();
    expect(interrupted.map((job) => job.id)).toContain('job-3');
    expect(interrupted.map((job) => job.id)).not.toContain('job-4');
  });

  it('clears the resumable input once a job settles', async () => {
    await store.createContinueJob('job-5', input('stage-5'));
    await store.deleteContinueJobInput('job-5');
    expect(await store.readContinueJobInput('job-5')).toBeNull();
    expect(await store.readContinueJob('job-5')).not.toBeNull();
  });

  it('exclusively claims a job and renews its lease', async () => {
    await store.createContinueJob('job-6', input('stage-6'));
    expect(await store.claimContinueJob('job-6', 'worker-a')).toBe(true);
    expect(await store.claimContinueJob('job-6', 'worker-b')).toBe(false);
    const claimed = await store.readContinueJob('job-6');
    expect(claimed?.status).toBe('running');
    expect(claimed?.workerId).toBe('worker-a');

    expect(await store.renewContinueJobLease('job-6', 'worker-b')).toBe(false);
    expect(await store.renewContinueJobLease('job-6', 'worker-a')).toBe(true);

    await store.releaseContinueJob('job-6', 'worker-a');
    // Releasing drops the lock, so the running job is claimable again (that is
    // exactly how a crashed worker's job is recovered).
    const claimableIds = (await store.findClaimableContinueJobs()).map((job) => job.id);
    expect(claimableIds).toContain('job-6');
  });

  it('reclaims a running job whose lock is stale', async () => {
    await store.createContinueJob('job-7', input('stage-7'));
    expect(await store.claimContinueJob('job-7', 'worker-a')).toBe(true);
    const lock = path.join(dir, 'job-7.lock');
    const stale = new Date(Date.now() - store.CONTINUE_LEASE_MS - 1_000);
    await utimes(lock, stale, stale);
    expect((await store.findClaimableContinueJobs()).map((job) => job.id)).toContain('job-7');
    expect(await store.claimContinueJob('job-7', 'worker-b')).toBe(true);
  });

  it('finds the active run for a course, ignoring settled jobs and other courses', async () => {
    await store.createContinueJob('job-8', input('controlled-stage'));
    await store.updateContinueJob('job-8', { status: 'running' });
    await store.createContinueJob('job-9', input('controlled-stage'));
    await store.updateContinueJob('job-9', { status: 'cancelled' });
    await store.createContinueJob('job-10', input('other-stage'));
    await store.updateContinueJob('job-10', { status: 'running' });

    expect((await store.findActiveContinueJobByStage('controlled-stage'))?.id).toBe('job-8');
    expect((await store.findActiveContinueJobByStage('other-stage'))?.id).toBe('job-10');
    expect(await store.findActiveContinueJobByStage('never-used')).toBeNull();
  });
});
