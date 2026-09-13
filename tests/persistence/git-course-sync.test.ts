import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  bindCourseRepository,
  CourseRepositoryAlreadyBoundError,
  CourseGitCommitScheduler,
  getCourseBinding,
  listCourseBindings,
  sanitizeStageFile,
  unbindCourseRepository,
} from '@/lib/persistence/git-course-sync';

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `maic-git-sync-${label}-`));
  tempRoots.push(dir);
  return dir;
}

const DOC_A = { stage: { id: 'stageA', name: 'Course A' }, scenes: [] };

describe('course git bindings', () => {
  it('binds, lists, resolves, and unbinds a freshly-initialized repo', async () => {
    const persistenceDir = makeTempDir('bindings');
    const repoPath = makeTempDir('repo');
    const binding = await bindCourseRepository({
      persistenceDir,
      stageId: 'stage A',
      repoPath,
      init: true,
    });
    expect(binding.stageId).toBe('stage A');
    expect(binding.repoPath).toBe(repoPath);

    expect(await getCourseBinding(persistenceDir, 'stage A')).toMatchObject({ stageId: 'stage A' });
    expect(await listCourseBindings(persistenceDir)).toHaveLength(1);

    expect(await unbindCourseRepository(persistenceDir, 'stage A')).toBe(true);
    expect(await getCourseBinding(persistenceDir, 'stage A')).toBeNull();
    expect(await unbindCourseRepository(persistenceDir, 'stage A')).toBe(false);
  });

  it('refuses a second binding for the same stage', async () => {
    const persistenceDir = makeTempDir('dup');
    const repoPath = makeTempDir('repo');
    await bindCourseRepository({ persistenceDir, stageId: 'stageA', repoPath, init: true });
    await expect(
      bindCourseRepository({ persistenceDir, stageId: 'stageA', repoPath }),
    ).rejects.toBeInstanceOf(CourseRepositoryAlreadyBoundError);
  });

  it('refuses binding to a path that is not a repository without init', async () => {
    const persistenceDir = makeTempDir('norepo');
    const repoPath = makeTempDir('notarepo');
    await expect(
      bindCourseRepository({ persistenceDir, stageId: 'stageA', repoPath }),
    ).rejects.toThrow(/not a git repository/);
  });
});

describe('CourseGitCommitScheduler', () => {
  it('commits the snapshot and skips a no-op second commit', async () => {
    const persistenceDir = makeTempDir('sched');
    const repoPath = makeTempDir('sched-repo');
    await bindCourseRepository({ persistenceDir, stageId: 'stageA', repoPath, init: true });

    const scheduler = new CourseGitCommitScheduler(persistenceDir, { debounceMs: 1 });
    let snapshot: unknown = { ...DOC_A, revision: 1 };
    scheduler.schedule('stageA', 'initial generation', async () => snapshot);
    await scheduler.flushForTesting();

    const file = join(repoPath, `${sanitizeStageFile('stageA')}.json`);
    expect(readFileSync(file, 'utf8')).toContain('"revision":1');
    const firstLog = execFileSync('git', ['-C', repoPath, 'log', '--oneline'], {
      encoding: 'utf8',
    }).trim();
    expect(firstLog).toMatch(/openmaic\(stageA\): initial generation/);

    // Identical snapshot → no second commit
    scheduler.schedule('stageA', 'unchanged write', async () => snapshot);
    await scheduler.flushForTesting();
    const logAfterNoop = execFileSync('git', ['-C', repoPath, 'log', '--oneline'], {
      encoding: 'utf8',
    }).trim();
    expect(logAfterNoop).toBe(firstLog);

    // Changed snapshot → second commit
    snapshot = { ...DOC_A, revision: 2 };
    scheduler.schedule('stageA', 'scene 2 done', async () => snapshot);
    await scheduler.flushForTesting();
    const logAfterChange = execFileSync('git', ['-C', repoPath, 'log', '--oneline'], {
      encoding: 'utf8',
    }).trim();
    expect(logAfterChange).toContain('openmaic(stageA): scene 2 done');
    expect(logAfterChange).toMatch(/openmaic\(stageA\): initial generation/);
    expect(logAfterChange.split('\n')).toHaveLength(2);
  });

  it('is a no-op for unbound stages and null snapshots', async () => {
    const persistenceDir = makeTempDir('noop');
    const scheduler = new CourseGitCommitScheduler(persistenceDir, { debounceMs: 1 });
    scheduler.schedule('missingStage', 'write', async () => ({ ok: true }));
    scheduler.schedule('nullStage', 'write', async () => null);
    await scheduler.flushForTesting();
    expect(await listCourseBindings(persistenceDir)).toHaveLength(0);
  });

  it('never rejects through the persistence path when git fails', async () => {
    const persistenceDir = makeTempDir('fail');
    const repoPath = makeTempDir('fail-repo');
    await bindCourseRepository({ persistenceDir, stageId: 'stageA', repoPath, init: true });
    const scheduler = new CourseGitCommitScheduler(persistenceDir, { debounceMs: 1 });
    // A snapshot that throws must swallow, not propagate to the caller.
    scheduler.schedule('stageA', 'write', async () => {
      throw new Error('snapshot exploded');
    });
    await expect(scheduler.flushForTesting()).resolves.toBeUndefined();
  });
});
