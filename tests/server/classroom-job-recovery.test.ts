import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '', generate: vi.fn() }));

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/classroom-storage')>();
  return {
    ...actual,
    get CLASSROOM_JOBS_DIR() {
      return state.dir;
    },
  };
});
vi.mock('@/lib/server/classroom-generation', () => ({
  generateClassroom: (...args: unknown[]) => state.generate(...args),
}));

import {
  INTERRUPTED_JOB_GRACE_MS,
  MAX_CLASSROOM_JOB_RESUMES,
  recoverInterruptedClassroomJob,
  recoverInterruptedClassroomJobs,
} from '@/lib/server/classroom-job-runner';
import {
  createClassroomGenerationJob,
  readClassroomGenerationJobRecord,
  readClassroomJobInput,
  saveClassroomJobInput,
  updateClassroomGenerationJob,
} from '@/lib/server/classroom-job-store';
import type { GenerateClassroomInput } from '@/lib/server/classroom-generation';

const input: GenerateClassroomInput = {
  requirement: 'Teach photosynthesis',
  enableWebSearch: true,
  webSearchApiKey: 'caller-secret',
};
const later = () => Date.now() + INTERRUPTED_JOB_GRACE_MS + 1_000;

async function interruptedJob(jobId: string, patch: Record<string, unknown> = {}) {
  await createClassroomGenerationJob(jobId, input);
  await saveClassroomJobInput(jobId, input, 'http://localhost:3000');
  await updateClassroomGenerationJob(jobId, {
    status: 'running',
    step: 'generating_scenes',
    ...patch,
  });
}

async function settled(jobId: string) {
  await vi.waitFor(async () => {
    const job = await readClassroomGenerationJobRecord(jobId);
    expect(job?.status === 'succeeded' || job?.status === 'failed').toBe(true);
  });
  // The input is removed right after the status settles.
  await vi.waitFor(async () => expect(await readClassroomJobInput(jobId)).toBeNull());
}

describe('interrupted classroom generation jobs', () => {
  beforeEach(async () => {
    state.dir = await mkdtemp(join(tmpdir(), 'classroom-jobs-'));
    state.generate.mockReset().mockResolvedValue({
      id: 'classroom-1',
      url: 'http://localhost:3000/classroom/classroom-1',
      stage: {},
      scenes: [],
      scenesCount: 3,
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    await rm(state.dir, { recursive: true, force: true });
  });

  it('keeps the input for a restart, without the caller’s search key', async () => {
    await saveClassroomJobInput('job-a', input, 'http://localhost:3000');

    const raw = await readFile(join(state.dir, 'job-a.input.json'), 'utf-8');
    expect(raw).not.toContain('caller-secret');
    expect(await readClassroomJobInput('job-a')).toEqual({
      input: { requirement: 'Teach photosynthesis', enableWebSearch: true },
      baseUrl: 'http://localhost:3000',
    });
  });

  it('runs a job the process lost again from its saved input', async () => {
    await interruptedJob('job-b');

    expect(await recoverInterruptedClassroomJob('job-b', later())).toBe(true);
    await settled('job-b');

    const job = await readClassroomGenerationJobRecord('job-b');
    expect(job?.status).toBe('succeeded');
    expect(job?.resumeCount).toBe(1);
    expect(job?.result?.classroomId).toBe('classroom-1');
    expect(state.generate).toHaveBeenCalledOnce();
    expect(state.generate.mock.calls[0]?.[0]).toMatchObject({
      requirement: 'Teach photosynthesis',
    });
  });

  it('leaves a job that reported moments ago to its runner', async () => {
    await interruptedJob('job-c');

    expect(await recoverInterruptedClassroomJob('job-c')).toBe(false);
    expect(state.generate).not.toHaveBeenCalled();
  });

  it('cannot restart a job whose input was never saved', async () => {
    await createClassroomGenerationJob('job-d', input);
    await updateClassroomGenerationJob('job-d', { status: 'running' });

    expect(await recoverInterruptedClassroomJob('job-d', later())).toBe(false);
  });

  it('fails a job interrupted past its resume budget', async () => {
    await interruptedJob('job-e', { resumeCount: MAX_CLASSROOM_JOB_RESUMES });

    expect(await recoverInterruptedClassroomJob('job-e', later())).toBe(false);

    const job = await readClassroomGenerationJobRecord('job-e');
    expect(job?.status).toBe('failed');
    expect(await readClassroomJobInput('job-e')).toBeNull();
    expect(state.generate).not.toHaveBeenCalled();
  });

  it('never touches a finished job', async () => {
    await interruptedJob('job-f', { status: 'succeeded' });

    expect(await recoverInterruptedClassroomJob('job-f', later())).toBe(false);
  });

  it('sweeps every interrupted job at startup', async () => {
    await interruptedJob('job-g');
    await interruptedJob('job-h');
    // Backdate both so the startup sweep (real clock) sees them as silent.
    for (const jobId of ['job-g', 'job-h']) {
      const path = join(state.dir, `${jobId}.json`);
      const job = JSON.parse(await readFile(path, 'utf-8'));
      job.updatedAt = new Date(Date.now() - INTERRUPTED_JOB_GRACE_MS - 1_000).toISOString();
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, JSON.stringify(job));
    }

    expect(await recoverInterruptedClassroomJobs()).toBe(2);
    await settled('job-g');
    await settled('job-h');

    const leftovers = await readdir(state.dir);
    expect(leftovers.filter((name) => name.endsWith('.input.json'))).toEqual([]);
  });
});
