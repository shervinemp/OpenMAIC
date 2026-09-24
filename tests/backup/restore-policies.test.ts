import { beforeEach, describe, expect, it, vi } from 'vitest';

const importClassroomZipMock = vi.hoisted(() => vi.fn());
const listStagesMock = vi.hoisted(() => vi.fn());
const deleteStageDataMock = vi.hoisted(() => vi.fn());
const kvGetMock = vi.hoisted(() => vi.fn());
const kvSetMock = vi.hoisted(() => vi.fn());
const mutateDocumentMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/import/use-import-classroom', () => ({
  importClassroomZip: importClassroomZipMock,
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  listStages: listStagesMock,
  deleteStageData: deleteStageDataMock,
}));
vi.mock('@/lib/document-store', () => ({
  accessDocument: vi.fn(),
  mutateDocument: mutateDocumentMock,
}));
vi.mock('@/lib/export/build-classroom-zip', () => ({
  addStageContentToZip: vi.fn(),
}));
vi.mock('file-saver', () => {
  const saveAs = vi.fn();
  return { saveAs, default: { saveAs } };
});
vi.mock('@openmaic/storage', () => ({
  BrowserKVStore: class {
    get = kvGetMock;
    set = kvSetMock;
  },
}));

import {
  COURSE_STATE_FILE,
  FULL_BACKUP_FORMAT,
  FULL_BACKUP_VERSION,
  restoreFullBackup,
  type RestoreMode,
} from '@/lib/backup/full-backup';

interface BackupCourseSpec {
  path: string;
  name: string;
  sourceId: string;
}

/** Build a minimal but well-formed full-backup ZIP in memory. */
async function buildBackupZip(options: {
  courses?: BackupCourseSpec[];
  settings?: { state: unknown; version?: number };
  /** Per-course-path `openmaic-course-state.json` payloads. */
  courseState?: Record<string, unknown>;
}): Promise<Uint8Array> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const courses = options.courses ?? [];
  zip.file(
    'manifest.json',
    JSON.stringify({
      format: FULL_BACKUP_FORMAT,
      version: FULL_BACKUP_VERSION,
      exportedAt: '2026-08-22T00:00:00.000Z',
      courseCount: courses.length,
      settingsIncluded: options.settings !== undefined,
      courses,
    }),
  );
  for (const course of courses) {
    // The restore only repacks the subtree and hands it to the import
    // pipeline (mocked here); the payload itself is opaque.
    zip.file(`${course.path}/manifest.json`, JSON.stringify({ stage: { name: course.name } }));
    const state = options.courseState?.[course.path];
    if (state) zip.file(`${course.path}/${COURSE_STATE_FILE}`, JSON.stringify(state));
  }
  if (options.settings) {
    zip.file('settings.json', JSON.stringify(options.settings));
  }
  // Raw bytes, not a File: JSZip cannot read this realm's File wrapper.
  return zip.generateAsync({ type: 'uint8array' });
}

describe('full backup restore policies', () => {
  beforeEach(() => {
    importClassroomZipMock.mockReset();
    importClassroomZipMock.mockResolvedValue('stage-new');
    listStagesMock.mockReset();
    listStagesMock.mockResolvedValue([]);
    deleteStageDataMock.mockReset();
    deleteStageDataMock.mockResolvedValue(undefined);
    kvGetMock.mockReset();
    kvGetMock.mockResolvedValue(undefined);
    kvSetMock.mockReset();
    mutateDocumentMock.mockReset();
  });

  it('re-attaches the backed-up outline record and rebinds scenes by order', async () => {
    const outline = {
      outlines: [{ id: 'o1', order: 1 }],
      blueprint: { lessons: [] },
      lessonGroups: [{ lessonId: 'lesson_1', jobs: [{ outlineId: 'o1', sceneId: 'old-scene-1' }] }],
      exams: { midterm: { kind: 'midterm', mcQuestions: [] } },
      examAttempts: { midterm: [{ id: 'a1' }] },
      generationComplete: true,
    };
    const blob = await buildBackupZip({
      courses: [{ path: 'courses/001-intro', name: 'Intro Course', sourceId: 'stage-src' }],
      courseState: {
        'courses/001-intro': {
          outline,
          scenes: [{ order: 1, id: 'old-scene-1', outlineId: 'o1' }],
        },
      },
    });
    const saveDocument = vi.fn(async () => undefined);
    mutateDocumentMock.mockImplementation(async (_stageId, work) =>
      work(
        {
          stage: { id: 'stage-new', name: 'Intro Course' },
          scenes: [{ id: 'new-scene-1', stageId: 'stage-new', order: 1 }],
        },
        { saveDocument },
      ),
    );

    const result = await restoreFullBackup(blob, { mode: 'add' });

    expect(result).toMatchObject({ restored: 1, failed: 0 });
    expect(mutateDocumentMock).toHaveBeenCalledWith('stage-new', expect.any(Function));
    expect(saveDocument).toHaveBeenCalledOnce();
    const [saved, options] = saveDocument.mock.calls[0] as unknown as [
      { scenes: Array<{ id: string; outlineId?: string }>; outline: typeof outline },
      { allowOlderOverwrite: boolean },
    ];
    expect(options).toEqual({ allowOlderOverwrite: true });
    expect(saved.scenes).toEqual([
      { id: 'new-scene-1', stageId: 'stage-new', order: 1, outlineId: 'o1' },
    ]);
    expect(saved.outline.exams).toEqual(outline.exams);
    expect(saved.outline.examAttempts).toEqual(outline.examAttempts);
    expect(saved.outline.lessonGroups[0].jobs[0].sceneId).toBe('new-scene-1');
  });

  it('restores a course whose backup predates the course-state sidecar', async () => {
    const blob = await buildBackupZip({
      courses: [{ path: 'courses/001-intro', name: 'Intro Course', sourceId: 'stage-src' }],
    });
    const result = await restoreFullBackup(blob, { mode: 'add' });
    expect(result).toMatchObject({ restored: 1, failed: 0 });
    expect(mutateDocumentMock).not.toHaveBeenCalled();
  });

  it('skips an existing course matched by source id without importing', async () => {
    listStagesMock.mockResolvedValue([{ id: 'stage-src', name: 'Renamed Since Export' }]);
    const blob = await buildBackupZip({
      courses: [{ path: 'courses/001-intro', name: 'Intro Course', sourceId: 'stage-src' }],
    });
    const phases: Array<[string, string]> = [];

    const result = await restoreFullBackup(blob, {
      mode: 'skip',
      onCourse: (label, phase) => phases.push([label, phase]),
    });

    expect(result).toMatchObject({ skipped: 1, restored: 0, replaced: 0, failed: 0 });
    expect(importClassroomZipMock).not.toHaveBeenCalled();
    expect(phases).toContainEqual(['001-intro', 'skipping']);
  });

  it('falls back to name matching when the source id no longer exists', async () => {
    listStagesMock.mockResolvedValue([{ id: 'stage-other-id', name: 'Intro Course' }]);
    const blob = await buildBackupZip({
      courses: [
        { path: 'courses/002-quantum', name: 'Quantum Basics', sourceId: 'stage-vanished' },
        { path: 'courses/003-intro', name: 'Intro Course', sourceId: 'also-vanished' },
      ],
    });

    const result = await restoreFullBackup(blob, { mode: 'skip' });

    // Only the name-matched duplicate is skipped; the other restores.
    expect(result.skipped).toBe(1);
    expect(result.restored).toBe(1);
  });

  it('replaces by importing first and deleting the old stage only after commit', async () => {
    listStagesMock.mockResolvedValue([{ id: 'stage-old', name: 'Intro Course' }]);
    const blob = await buildBackupZip({
      courses: [{ path: 'courses/001-intro', name: 'Intro Course', sourceId: 'stage-old' }],
    });

    const result = await restoreFullBackup(blob, { mode: 'replace' });

    expect(result).toMatchObject({ replaced: 1, failed: 0 });
    // Ordering is the safety property: the old stage may only be deleted once
    // the replacement has fully committed.
    const importOrder = importClassroomZipMock.mock.invocationCallOrder[0];
    const deleteOrder = deleteStageDataMock.mock.invocationCallOrder[0];
    expect(importOrder).toBeLessThan(deleteOrder);
    expect(deleteStageDataMock).toHaveBeenCalledWith('stage-old');
  });

  it('never deletes the existing stage when the replacement import fails', async () => {
    listStagesMock.mockResolvedValue([{ id: 'stage-old', name: 'Intro Course' }]);
    importClassroomZipMock.mockRejectedValue(new Error('disk full mid-import'));
    const blob = await buildBackupZip({
      courses: [{ path: 'courses/001-intro', name: 'Intro Course', sourceId: 'stage-old' }],
    });

    const result = await restoreFullBackup(blob, { mode: 'replace' });

    expect(result.failed).toBe(1);
    expect(result.replaced).toBe(0);
    expect(deleteStageDataMock).not.toHaveBeenCalled();
  });

  it('adds duplicates on purpose in add mode', async () => {
    listStagesMock.mockResolvedValue([{ id: 'stage-src', name: 'Intro Course' }]);
    const blob = await buildBackupZip({
      courses: [{ path: 'courses/001-intro', name: 'Intro Course', sourceId: 'stage-src' }],
    });

    const result = await restoreFullBackup(blob, { mode: 'add' as RestoreMode });

    expect(result).toMatchObject({ restored: 1, skipped: 0, replaced: 0 });
    expect(importClassroomZipMock).toHaveBeenCalledTimes(1);
    expect(deleteStageDataMock).not.toHaveBeenCalled();
  });

  it('merges sanitized settings over live credentials instead of wiping them', async () => {
    kvGetMock.mockResolvedValue({
      state: { ttsProvidersConfig: { kokoro: { apiKey: 'live-key', voice: 'am_michael' } } },
      version: 4,
    });
    const blob = await buildBackupZip({
      settings: {
        state: { ttsProvidersConfig: { kokoro: { voice: 'af_heart', speed: 1.1 } }, theme: 'dark' },
        version: 5,
      },
    });

    const result = await restoreFullBackup(blob);

    expect(result.settingsRestored).toBe(true);
    expect(kvSetMock).toHaveBeenCalledWith(
      'settings-storage',
      {
        state: {
          ttsProvidersConfig: { kokoro: { apiKey: 'live-key', voice: 'af_heart', speed: 1.1 } },
          theme: 'dark',
        },
        version: 5,
      },
      'account',
    );
  });

  it('rejects backups with an unsupported format or version', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file(
      'manifest.json',
      JSON.stringify({ format: FULL_BACKUP_FORMAT, version: 99, courses: [] }),
    );
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    await expect(restoreFullBackup(bytes)).rejects.toThrow(/Unsupported backup format/);
  });

  it('counts a per-course failure and keeps restoring the remaining courses', async () => {
    importClassroomZipMock
      .mockRejectedValueOnce(new Error('corrupt course payload'))
      .mockResolvedValueOnce('stage-b');
    const blob = await buildBackupZip({
      courses: [
        { path: 'courses/001-bad', name: 'Broken', sourceId: 'gone-a' },
        { path: 'courses/002-good', name: 'Fine', sourceId: 'gone-b' },
      ],
    });

    const result = await restoreFullBackup(blob, { mode: 'add' });

    expect(result).toMatchObject({ restored: 1, failed: 1 });
    expect(importClassroomZipMock).toHaveBeenCalledTimes(2);
  });
});
