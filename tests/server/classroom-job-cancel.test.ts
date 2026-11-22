import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  dir: '',
  generate: vi.fn(),
  calls: [] as Array<{ signal?: AbortSignal }>,
}));

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
  cancelClassroomGenerationJob,
  recoverInterruptedClassroomJob,
  runClassroomGenerationJob,
} from '@/lib/server/classroom-job-runner';
import {
  createClassroomGenerationJob,
  markClassroomGenerationJobSucceeded,
  readClassroomGenerationJobRecord,
  readClassroomJobInput,
  saveClassroomJobInput,
  updateClassroomGenerationJob,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';
import type { GenerateClassroomInput, GenerateClassroomResult } from '@/lib/server/classroom-generation';

const input: GenerateClassroomInput = { requirement: 'Teach photosynthesis' };
const result = {
  id: 'classroom-1',
  url: 'http://localhost:3000/classroom/classroom-1',
  stage: {},
  scenes: [],
  scenesCount: 3,
  createdAt: new Date().toISOString(),
} as unknown as GenerateClassroomResult;

describe('classroom generation job cancellation', () => {
  beforeEach(async () => {
    state.dir = await mkdtemp(join(tmpdir(), 'classroom-cancel-'));
    state.calls = [];
    state.generate.mockReset().mockImplementation((_input: unknown, options: unknown) => {
      const opts = options as { signal?: AbortSignal };
      state.calls.push(opts);
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener(
          'abort',
          () => reject(opts.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    });
  });

  afterEach(async () => {
    await rm(state.dir, { recursive: true, force: true });
  });

  it('aborts the in-flight run, marks it cancelled, and drops the saved input', async () => {
    await createClassroomGenerationJob('cancel-1', input);
    await saveClassroomJobInput('cancel-1', input, 'http://localhost:3000');
    void runClassroomGenerationJob('cancel-1', input, 'http://localhost:3000');
    await vi.waitFor(() => expect(state.calls).toHaveLength(1));
    expect((await readClassroomGenerationJobRecord('cancel-1'))?.status).toBe('running');

    const cancelled = await cancelClassroomGenerationJob('cancel-1');
    expect(cancelled?.status).toBe('cancelled');
    expect(state.calls[0]?.signal?.aborted).toBe(true);
    await vi.waitFor(async () => expect(await readClassroomJobInput('cancel-1')).toBeNull());
  });

  it('keeps the cancelled verdict when the aborted run reports late progress and success', async () => {
    await createClassroomGenerationJob('cancel-2', input);
    await cancelClassroomGenerationJob('cancel-2');

    await updateClassroomGenerationJobProgress('cancel-2', {
      step: 'generating_scenes',
      progress: 50,
      message: 'late progress',
      scenesGenerated: 5,
    });
    await markClassroomGenerationJobSucceeded('cancel-2', result);

    const job = await readClassroomGenerationJobRecord('cancel-2');
    expect(job?.status).toBe('cancelled');
    expect(job?.result).toBeUndefined();
  });

  it('is idempotent for terminal jobs and returns null for unknown ids', async () => {
    await createClassroomGenerationJob('cancel-3', input);
    await markClassroomGenerationJobSucceeded('cancel-3', result);

    expect((await cancelClassroomGenerationJob('cancel-3'))?.status).toBe('succeeded');
    expect(await cancelClassroomGenerationJob('does-not-exist')).toBeNull();
    expect(state.generate).not.toHaveBeenCalled();
  });

  it('cannot be restarted by interrupted-job recovery', async () => {
    await createClassroomGenerationJob('cancel-4', input);
    await saveClassroomJobInput('cancel-4', input, 'http://localhost:3000');
    await cancelClassroomGenerationJob('cancel-4');
    // Restore the sidecar so this exercises the status guard, not the missing input.
    await saveClassroomJobInput('cancel-4', input, 'http://localhost:3000');
    await updateClassroomGenerationJob('cancel-4', {
      updatedAt: new Date(Date.now() - INTERRUPTED_JOB_GRACE_MS - 1_000).toISOString(),
    });

    expect(await recoverInterruptedClassroomJob('cancel-4', Date.now())).toBe(false);
    expect(state.generate).not.toHaveBeenCalled();
  });
});
