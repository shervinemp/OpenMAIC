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

  it('scans a repository shared by several bound courses once', async () => {
    writeFileSync(join(repoPath, 'importStage.json'), JSON.stringify(makeDoc('importStage')), 'utf8');
    await bindRepo();
    await bindCourseRepository({ persistenceDir, stageId: 'secondBound', repoPath });

    const snapshots = await listRepoCourseSnapshots(persistenceDir);
    expect(snapshots.map((snapshot) => snapshot.stageId)).toEqual(['importStage']);
    expect(await scanCourseUpdates(persistenceDir)).toHaveLength(1);
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

  it('manifest-driven materialization: applying a snapshot restores its committed media bytes into the asset store', async () => {
    // The repo carries a slide with tts narration committed next to the doc.
    const doc = {
      stage: { id: 'boundExisting', name: 'Course boundExisting', createdAt: 1, updatedAt: 2 },
      scenes: [
        {
          id: 'scene-0',
          stageId: 'boundExisting',
          order: 1,
          type: 'slide',
          title: 'With narration',
          content: {
            type: 'slide',
            canvas: {
              id: 'canvas-0',
              viewportSize: 1000,
              viewportRatio: 0.5625,
              theme: { backgroundColor: '#fff', themeColors: ['#000'], fontColor: '#000', fontName: 'Inter' },
              elements: [],
            },
          },
          actions: [{ type: 'speech', id: 'a0', text: 'hello', audioId: 'tts_s1_a0' }],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      dslVersion: '0.2.0',
    };
    writeFileSync(join(repoPath, 'boundExisting.json'), JSON.stringify(doc), 'utf8');
    mkdirSync(join(repoPath, 'assets', 'boundExisting', '.meta'), { recursive: true });
    writeFileSync(
      join(repoPath, 'assets', 'boundExisting', 'tts_s1_a0'),
      Buffer.from('wav-wav-wav'),
    );
    writeFileSync(
      join(repoPath, 'assets', 'boundExisting', '.meta', 'tts_s1_a0.json'),
      JSON.stringify({ mime: 'audio/wav', meta: {}, size: 11 }),
      'utf8',
    );
    persistDocument('boundExisting', makeDoc('boundExisting'));
    await bindRepo({ autoLoad: true });

    const applied = await runCourseGitSync(persistenceDir, { apply: true, stageIds: ['boundExisting'] });
    expect(applied.results[0].action).toBe('applied');
    expect(applied.results[0].detail).toContain('media rows restored: 1');

    // The bytes AND the sidecar landed in the server store under the
    // encoded ref; the meta content flows through too.
    const restored = readFileSync(join(persistenceDir, 'assets', 'tts_s1_a0'));
    expect(restored.toString()).toContain('wav-wav');
    const meta = JSON.parse(readFileSync(join(persistenceDir, 'assets', '.meta', 'tts_s1_a0.json'), 'utf8')) as {
      mime?: string;
    };
    expect(meta.mime).toBe('audio/wav');

    // Idempotent: a re-apply does not duplicate-restores or demote rows.
    const again = await runCourseGitSync(persistenceDir, { apply: true, stageIds: ['boundExisting'] });
    expect(again.results[0].detail).not.toContain('media rows restored: 1');
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
