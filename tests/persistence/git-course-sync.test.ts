import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('refuses two stageIds sanitizing to the same snapshot file in one repo', async () => {
    const persistenceDir = makeTempDir('collide');
    const repoPath = makeTempDir('repo');
    await bindCourseRepository({ persistenceDir, stageId: 'a 1', repoPath, init: true });
    await expect(
      bindCourseRepository({ persistenceDir, stageId: 'a_1', repoPath }),
    ).rejects.toThrow(/share the snapshot file/);
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

  it('provisions git-lfs and commits media as LFS pointers (idempotent, no churn)', async () => {
    const persistenceDir = makeTempDir('media');
    const repoPath = makeTempDir('media-repo');
    await bindCourseRepository({ persistenceDir, stageId: 'stageA', repoPath, init: true });
    // One resolvable narration asset in the store (bytes + meta sidecar).
    const ref = 'tts_stageA_probe_1';
    mkdirSync(join(persistenceDir, 'assets', '.meta'), { recursive: true });
    writeFileSync(join(persistenceDir, 'assets', ref), 'audio-bytes-probe');
    writeFileSync(
      join(persistenceDir, 'assets', '.meta', `${ref}.json`),
      JSON.stringify({ mime: 'audio/wav', meta: {}, size: 17 }),
    );
    const document = { ...DOC_A, scenes: [{ audioId: ref }] };
    const scheduler = new CourseGitCommitScheduler(persistenceDir, {
      debounceMs: 1,
      includeMedia: true,
    });
    scheduler.schedule('stageA', 'media snapshot', async () => document);
    await scheduler.flushForTesting();

    // The pipeline itself provisioned LFS tracking for assets/**.
    expect(readFileSync(join(repoPath, '.gitattributes'), 'utf8')).toContain('assets/**');
    // The committed asset is a POINTER, not raw bytes (bytes live in the LFS store).
    const committed = execFileSync('git', ['-C', repoPath, 'show', `HEAD:assets/stageA/${ref}`], {
      encoding: 'utf8',
    });
    expect(committed).toContain('version https://git-lfs.github.com/spec/v1');
    // Identical snapshot → no commit churn (the manifest timestamp must not
    // keep the index permanently dirty).
    const logBefore = execFileSync('git', ['-C', repoPath, 'log', '--oneline'], {
      encoding: 'utf8',
    }).trim();
    scheduler.schedule('stageA', 'unchanged', async () => document);
    await scheduler.flushForTesting();
    const logAfter = execFileSync('git', ['-C', repoPath, 'log', '--oneline'], {
      encoding: 'utf8',
    }).trim();
    expect(logAfter).toBe(logBefore);
    // fsck stays clean over the whole flow.
    const fsck = execFileSync('git', ['-C', repoPath, 'fsck', '--full', '--no-dangling'], {
      encoding: 'utf8',
    });
    expect(fsck).not.toMatch(/corrupt|missing/);
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

  it('commits a removal for scheduleDelete (deleted course vanishes from the repo)', async () => {
    const persistenceDir = makeTempDir('delete');
    const repoPath = makeTempDir('delete-repo');
    await bindCourseRepository({ persistenceDir, stageId: 'stageA', repoPath, init: true });
    const scheduler = new CourseGitCommitScheduler(persistenceDir, { debounceMs: 1 });
    const file = join(repoPath, `${sanitizeStageFile('stageA')}.json`);
    scheduler.schedule('stageA', 'write', async () => DOC_A);
    await scheduler.flushForTesting();
    expect(readFileSync(file, 'utf8')).toContain('Course A');

    scheduler.scheduleDelete('stageA', 'delete course');
    await scheduler.flushForTesting();
    expect(() => readFileSync(file, 'utf8')).toThrow();
    const logText = execFileSync('git', ['-C', repoPath, 'log', '--oneline'], {
      encoding: 'utf8',
    });
    expect(logText).toContain('openmaic(stageA): delete course');
  });

  it('commits two stages of the same repo sequentially (no index-lock races)', async () => {
    const persistenceDir = makeTempDir('seq');
    const repoPath = makeTempDir('seq-repo');
    await bindCourseRepository({ persistenceDir, stageId: 'stageA', repoPath, init: true });
    await bindCourseRepository({ persistenceDir, stageId: 'stageB', repoPath });
    const scheduler = new CourseGitCommitScheduler(persistenceDir, { debounceMs: 1 });
    scheduler.schedule('stageA', 'stage A write', async () => DOC_A);
    scheduler.schedule('stageB', 'stage B write', async () => ({
      stage: { id: 'stageB', name: 'Course B' },
      scenes: [],
    }));
    // Both jobs land in ONE flush: flush already partitions per repo and runs
    // the jobs sequentially, so neither add/commit collides on the index lock.
    await scheduler.flushForTesting();
    expect(readFileSync(join(repoPath, 'stageA.json'), 'utf8')).toContain('stageA');
    expect(readFileSync(join(repoPath, 'stageB.json'), 'utf8')).toContain('stageB');
    const logText = execFileSync('git', ['-C', repoPath, 'log', '--oneline'], {
      encoding: 'utf8',
    }).trim();
    expect(logText).toContain('openmaic(stageA): stage A write');
    expect(logText).toContain('openmaic(stageB): stage B write');
  });
});
