import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '@/lib/types/generation';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  bulkDelete: vi.fn(),
  toArray: vi.fn(),
  sortBy: vi.fn(),
  below: vi.fn(),
  equals: vi.fn(),
  whereDelete: vi.fn(),
}));

vi.mock('@/lib/utils/database', () => ({
  db: {
    sceneDrafts: {
      get: mocks.get,
      put: mocks.put,
      delete: mocks.delete,
      bulkDelete: mocks.bulkDelete,
      where: (field: string) => {
        if (field === 'updatedAt') return { below: mocks.below };
        return { equals: mocks.equals };
      },
    },
  },
}));

import {
  clearSceneDraftsForStage,
  deleteSceneDraft,
  loadSceneDrafts,
  saveSceneDraft,
  sceneDraftId,
} from '@/lib/utils/scene-draft-store';
import { sceneDraftSourceKey } from '@/lib/utils/scene-draft-key';

const outline = (id: string): SceneOutline =>
  ({ id, type: 'slide', title: 'T', description: 'D', keyPoints: ['k'], order: 1 }) as SceneOutline;

describe('sceneDraftSourceKey', () => {
  it('is stable for identical inputs', () => {
    const input = { stageId: 's', outline: outline('o1'), model: 'm' };
    expect(sceneDraftSourceKey(input)).toBe(sceneDraftSourceKey({ ...input }));
  });

  it('changes when the model or outline changes', () => {
    const base = { stageId: 's', outline: outline('o1'), model: 'm' };
    expect(sceneDraftSourceKey({ ...base, model: 'other' })).not.toBe(sceneDraftSourceKey(base));
    expect(sceneDraftSourceKey({ ...base, outline: outline('o2') })).not.toBe(
      sceneDraftSourceKey(base),
    );
  });
});

describe('scene-draft store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(undefined);
    mocks.below.mockReturnValue({ toArray: mocks.toArray });
    mocks.toArray.mockResolvedValue([]);
    mocks.equals.mockReturnValue({
      toArray: mocks.toArray,
      sortBy: mocks.sortBy,
      delete: mocks.whereDelete,
    });
    mocks.sortBy.mockResolvedValue([]);
    mocks.put.mockResolvedValue(undefined);
    mocks.bulkDelete.mockResolvedValue(undefined);
    mocks.delete.mockResolvedValue(undefined);
    mocks.whereDelete.mockResolvedValue(undefined);
  });

  it('uses a compound id per stage and outline', () => {
    expect(sceneDraftId('stage-1', 'o1')).toBe('stage-1::o1');
  });

  it('merges an actions write into an existing content draft without losing content', async () => {
    const content = { success: true, content: { elements: [] } };
    mocks.get.mockResolvedValueOnce({
      id: 'stage-1::o1',
      stageId: 'stage-1',
      outlineId: 'o1',
      sourceKey: 'k',
      content,
      createdAt: 10,
      updatedAt: 10,
    });

    await saveSceneDraft('stage-1', 'o1', { sourceKey: 'k', actions: { success: true } });

    expect(mocks.put).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'stage-1::o1',
        sourceKey: 'k',
        content,
        actions: { success: true },
        createdAt: 10,
      }),
    );
  });

  it('drops stale actions when content is regenerated under a new source key', async () => {
    mocks.get.mockResolvedValueOnce({
      id: 'stage-1::o1',
      stageId: 'stage-1',
      outlineId: 'o1',
      sourceKey: 'OLD',
      content: { old: true },
      actions: { stale: true },
      createdAt: 10,
      updatedAt: 10,
    });

    await saveSceneDraft('stage-1', 'o1', { sourceKey: 'NEW', content: { fresh: true } });

    const written = mocks.put.mock.calls[0][0] as Record<string, unknown>;
    expect(written.sourceKey).toBe('NEW');
    expect(written.content).toEqual({ fresh: true });
    expect(written.actions).toBeUndefined();
  });

  it('evacuates old drafts beyond the per-stage cap', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `stage-1::o${i}`,
      stageId: 'stage-1',
      outlineId: `o${i}`,
      sourceKey: 'k',
      updatedAt: i,
    }));
    mocks.sortBy.mockResolvedValueOnce(rows);

    await saveSceneDraft('stage-1', 'o29', { sourceKey: 'k', content: {} });

    expect(mocks.bulkDelete).toHaveBeenCalledTimes(1);
    const deleted = mocks.bulkDelete.mock.calls[0][0] as string[];
    expect(deleted).toHaveLength(6); // 30 mocked rows, cap 24
    expect(deleted[0]).toBe('stage-1::o0');
  });

  it('sweeps stale rows globally when a batch loads drafts', async () => {
    mocks.toArray.mockResolvedValueOnce([{ id: 'old' }]); // stale sweep
    mocks.toArray.mockResolvedValueOnce([]); // stage rows

    await loadSceneDrafts('stage-1');

    expect(mocks.below).toHaveBeenCalled();
    expect(mocks.bulkDelete).toHaveBeenCalledWith(['old']);
  });

  it('deletes one draft and clears a whole stage', async () => {
    await deleteSceneDraft('s', 'o1');
    expect(mocks.delete).toHaveBeenCalledWith('s::o1');

    await clearSceneDraftsForStage('s');
    expect(mocks.equals).toHaveBeenCalledWith('s');
    expect(mocks.whereDelete).toHaveBeenCalledOnce();
  });
});
