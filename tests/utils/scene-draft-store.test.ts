import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@/lib/types/generation';
import { sceneDraftSourceKey } from '@/lib/utils/scene-draft-key';
import {
  MAX_DRAFTS_PER_STAGE,
  mergeSceneDraft,
  pruneSceneDrafts,
  sceneDraftId,
  type SceneDraft,
} from '@/lib/utils/scene-draft-model';

const outline = (id: string): SceneOutline =>
  ({ id, type: 'slide', title: 'T', description: 'D', keyPoints: ['k'], order: 1 }) as SceneOutline;

const draft = (overrides: Partial<SceneDraft> = {}): SceneDraft => ({
  id: 'stage-1::o1',
  stageId: 'stage-1',
  outlineId: 'o1',
  sourceKey: 'k',
  content: { content: true },
  createdAt: 10,
  updatedAt: 10,
  ...overrides,
});

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

describe('scene draft model', () => {
  it('uses a compound id per stage and outline', () => {
    expect(sceneDraftId('stage-1', 'o1')).toBe('stage-1::o1');
  });

  it('merges an actions write into a content draft without losing content', () => {
    const merged = mergeSceneDraft(draft(), 'stage-1', 'o1', {
      sourceKey: 'k',
      actions: { success: true },
    });
    expect(merged).toMatchObject({
      id: 'stage-1::o1',
      sourceKey: 'k',
      content: { content: true },
      actions: { success: true },
      createdAt: 10,
    });
  });

  it('drops the other half when the source key changes', () => {
    const merged = mergeSceneDraft(draft(), 'stage-1', 'o1', {
      sourceKey: 'NEW',
      content: { fresh: true },
    });
    expect(merged.sourceKey).toBe('NEW');
    expect(merged.content).toEqual({ fresh: true });
    expect(merged.actions).toBeUndefined();
  });

  it('keeps only the newest drafts up to the cap and drops stale ones', () => {
    const now = Date.now();
    const rows = Array.from({ length: 30 }, (_, i) =>
      draft({ id: `stage-1::o${i}`, outlineId: `o${i}`, updatedAt: now - (30 - i) * 1000 }),
    );
    rows.push(draft({ id: 'stage-1::old', outlineId: 'old', updatedAt: now - 2 * 86400_1000 }));
    const pruned = pruneSceneDrafts(rows, now);
    expect(pruned).toHaveLength(MAX_DRAFTS_PER_STAGE);
    expect(pruned[0].outlineId).toBe('o6');
    expect(pruned.some((row) => row.outlineId === 'old')).toBe(false);
  });
});
