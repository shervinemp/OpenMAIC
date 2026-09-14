import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { bindCourseRepository } from '@/lib/persistence/git-course-sync';
import {
  listRepoCourseSnapshots,
  runCourseGitSync,
  scanCourseUpdates,
} from '@/lib/persistence/git-course-import';

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function makeTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `maic-git-import-${label}-`));
  tempRoots.push(dir);
  return dir;
}

const makeDoc = (id: string, sceneCount = 1, updatedAt = 1) => ({
  stage: { id, name: `Course ${id}`, createdAt: 1, updatedAt },
  scenes: Array.from({ length: sceneCount }, (_, index) => ({
    id: `scene-${index}`,
    stageId: id,
    order: index + 1,
    type: 'interactive',
    title: 'Widget',
    content: { type: 'interactive', html: '<p>hi</p>' },
    createdAt: 1,
    updatedAt: 1,
  })),
  dslVersion: '0.2.0',
});

let persistenceDir: string;
let repoPath: string;

beforeEach(() => {
  persistenceDir = makeTempDir('persist');
  repoPath = makeTempDir('repo');
});

function bindRepo(opts: { autoLoad?: boolean } = {}) {
  return bindCourseRepository({
    persistenceDir,
    stageId: 'boundExisting',
    repoPath,
    init: true,
    autoLoad: opts.autoLoad,
  });
}

function persistDocument(stageId: string, doc: unknown): void {
  mkdirSync(join(persistenceDir, 'documents'), { recursive: true });
  writeFileSync(join(persistenceDir, 'documents', `${stageId}.json`), JSON.stringify(doc), 'utf8');
}

function persistedDocuments(): string[] {
  try {
    return readdirSync(join(persistenceDir, 'documents'));
  } catch {
    return [];
  }
}

describe('inbound course git sync', () => {
  it('discovers repo snapshots with title/sceneCount', async () => {
    writeFileSync(join(repoPath, 'importStage.json'), JSON.stringify(makeDoc('importStage', 2)), 'utf8');
    writeFileSync(join(repoPath, 'not-a-course.txt'), 'ignore me', 'utf8');
    writeFileSync(join(repoPath, '.hidden.json'), JSON.stringify(makeDoc('hidden')), 'utf8');
    await bindRepo();

    const snapshots = await listRepoCourseSnapshots(persistenceDir);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      stageId: 'importStage',
      title: 'Course importStage',
      sceneCount: 2,
      stageFile: 'importStage',
    });
  });

  it('reports new/equal/update states against persistence', async () => {
    writeFileSync(join(repoPath, 'importStage.json'), JSON.stringify(makeDoc('importStage')), 'utf8');
    await bindRepo({ autoLoad: true });

    expect((await scanCourseUpdates(persistenceDir)).map((c) => c.state)).toEqual(['new']);

    await runCourseGitSync(persistenceDir, { importNew: true });
    expect((await scanCourseUpdates(persistenceDir)).map((c) => c.state)).toEqual(['equal']);

    writeFileSync(
      join(repoPath, 'importStage.json'),
      JSON.stringify(makeDoc('importStage', 3, 2)),
      'utf8',
    );
    expect((await scanCourseUpdates(persistenceDir)).map((c) => c.state)).toEqual(['update']);
  });

  it('imports new courses only when importNew AND the binding autoLoads', async () => {
    writeFileSync(join(repoPath, 'importStage.json'), JSON.stringify(makeDoc('importStage')), 'utf8');
    await bindRepo({ autoLoad: true });

    const noImport = await runCourseGitSync(persistenceDir, { importNew: false });
    expect(noImport.results[0]).toMatchObject({ action: 'skipped' });

    const imported = await runCourseGitSync(persistenceDir, { importNew: true });
    expect(imported.results[0]).toMatchObject({ action: 'imported' });
    expect(persistedDocuments()).toContain('importStage.json');
  });

  it('does not auto-import without the binding autoLoad flag', async () => {
    writeFileSync(join(repoPath, 'importStage.json'), JSON.stringify(makeDoc('importStage')), 'utf8');
    await bindRepo();

    const onboard = await runCourseGitSync(persistenceDir, { importNew: true });
    expect(onboard.results[0]).toMatchObject({ action: 'skipped' });
    expect(persistedDocuments()).not.toContain('importStage.json');
  });

  it('never auto-applies updates and never applies outside the approval list', async () => {
    persistDocument('boundExisting', makeDoc('boundExisting'));
    writeFileSync(
      join(repoPath, 'boundExisting.json'),
      JSON.stringify({ ...makeDoc('boundExisting', 2, 99) }),
      'utf8',
    );
    await bindRepo({ autoLoad: true });

    const passive = await runCourseGitSync(persistenceDir, { importNew: true });
    expect(passive.results[0]).toMatchObject({ action: 'skipped' });

    const wrongId = await runCourseGitSync(persistenceDir, {
      apply: true,
      stageIds: ['someOtherCourse'],
    });
    expect(wrongId.results[0]).toMatchObject({ action: 'skipped' });

    const applied = await runCourseGitSync(persistenceDir, { apply: true, stageIds: ['boundExisting'] });
    expect(applied.results[0]).toMatchObject({ action: 'applied' });
    const persisted = JSON.parse(readFileSync(join(persistenceDir, 'documents', 'boundExisting.json'), 'utf8')) as {
      scenes: unknown[];
    };
    expect(persisted.scenes).toHaveLength(2);
  });
});
