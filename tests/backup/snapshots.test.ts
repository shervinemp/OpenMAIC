import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildFullBackupZipMock = vi.hoisted(() => vi.fn());
const listSnapshotsMock = vi.hoisted(() => vi.fn());
const deleteSnapshotMock = vi.hoisted(() => vi.fn());
const putSnapshotMock = vi.hoisted(() => vi.fn());
const kvGetMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/backup/full-backup', () => ({
  buildFullBackupZip: buildFullBackupZipMock,
}));
vi.mock('@/lib/backup/snapshot-store', () => ({
  listSnapshots: listSnapshotsMock,
  deleteSnapshot: deleteSnapshotMock,
  putSnapshot: putSnapshotMock,
}));
vi.mock('@openmaic/storage', () => ({
  // Preferences live in the account KV scope; only get() is read here.
  BrowserKVStore: class {
    get = kvGetMock;
    async set(): Promise<void> {}
  },
}));

/**
 * Snapshot orchestration keeps a bounded ring of full-backup copies in
 * IndexedDB. The store itself is mocked; these tests pin the orchestration:
 * what gets captured, the oversize guard, and which snapshots survive pruning.
 */
describe('snapshot orchestration', () => {
  const meta = (id: string, savedAt: number) => ({
    id,
    savedAt,
    label: 'automatic',
    size: 1000,
    courseCount: 2,
    settingsIncluded: true,
  });

  beforeEach(() => {
    vi.resetModules();
    buildFullBackupZipMock.mockReset();
    listSnapshotsMock.mockReset().mockResolvedValue([]);
    deleteSnapshotMock.mockReset().mockResolvedValue(undefined);
    putSnapshotMock.mockReset().mockResolvedValue(undefined);
    kvGetMock.mockReset().mockResolvedValue({ autoSnapshots: false });
  });

  it('prunes to the newest MAX_AUTO_SNAPSHOTS copies', async () => {
    const { MAX_AUTO_SNAPSHOTS, pruneSnapshots } = await import('@/lib/backup/snapshots');
    const eight = Array.from({ length: 8 }, (_, index) => meta(`snap-${index}`, index * 1000));
    listSnapshotsMock.mockResolvedValue(eight);

    await pruneSnapshots();

    const deletedIds = deleteSnapshotMock.mock.calls.map((call) => call[0] as string);
    expect(deletedIds.sort()).toEqual(['snap-0', 'snap-1']);
    expect(MAX_AUTO_SNAPSHOTS).toBeGreaterThan(0);
    // The six newest survive untouched.
    for (let index = 2; index < 8; index++) {
      expect(deletedIds).not.toContain(`snap-${index}`);
    }
  });

  it('refuses to keep a snapshot larger than the local size cap', async () => {
    const { captureSnapshot } = await import('@/lib/backup/snapshots');
    buildFullBackupZipMock.mockResolvedValue({
      blob: { size: 513 * 1024 * 1024 },
      manifest: { exportedAt: '2026-08-22T10:00:00.000Z', courseCount: 1, settingsIncluded: true },
    });

    const result = await captureSnapshot('manual');

    expect(result).toBeNull();
    expect(putSnapshotMock).not.toHaveBeenCalled();
  });

  it('captures a snapshot whose metadata is derived from the backup manifest', async () => {
    const { captureSnapshot } = await import('@/lib/backup/snapshots');
    buildFullBackupZipMock.mockResolvedValue({
      blob: { size: 2048 },
      manifest: {
        exportedAt: '2026-08-22T10:00:00.000Z',
        courseCount: 3,
        settingsIncluded: true,
      },
    });

    const snapshot = await captureSnapshot('before-migration');

    expect(snapshot).toMatchObject({
      id: '2026-08-22T10:00:00.000Z',
      savedAt: Date.parse('2026-08-22T10:00:00.000Z'),
      label: 'before-migration',
      size: 2048,
      courseCount: 3,
      settingsIncluded: true,
    });
    expect(putSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it('automatic capture honors the preference switch', async () => {
    const { captureAutomaticIfDue } = await import('@/lib/backup/snapshots');
    kvGetMock.mockResolvedValue({ autoSnapshots: false });

    await captureAutomaticIfDue();

    expect(buildFullBackupZipMock).not.toHaveBeenCalled();
  });

  it('automatic capture runs at most once per interval even if invoked repeatedly', async () => {
    const { captureAutomaticIfDue } = await import('@/lib/backup/snapshots');
    kvGetMock.mockResolvedValue({ autoSnapshots: true });
    buildFullBackupZipMock.mockResolvedValue({
      blob: { size: 512 },
      manifest: {
        exportedAt: '2026-08-22T11:00:00.000Z',
        courseCount: 0,
        settingsIncluded: false,
      },
    });

    await captureAutomaticIfDue();
    await captureAutomaticIfDue();
    await captureAutomaticIfDue();

    expect(buildFullBackupZipMock).toHaveBeenCalledTimes(1);
    expect(putSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
