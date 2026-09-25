import { describe, expect, it } from 'vitest';

import { indexScenesByOutline } from '@/lib/utils/outline-scene-match';

const outline = (id: string, order: number) => ({ id, order });

describe('indexScenesByOutline', () => {
  // A finished deck the user edited: outline 1's slide deleted, then outline
  // 3's slide dragged to the front — the reorder renumbers scenes 1..n.
  const edited = [
    { id: 's3', outlineId: 'o3', order: 1 },
    { id: 's2', outlineId: 'o2', order: 2 },
  ];

  it('matches by the outline id a scene was generated from, not its position', () => {
    const index = indexScenesByOutline(edited);

    expect(index.has(outline('o1', 1))).toBe(false);
    expect(index.sceneFor(outline('o3', 3))?.id).toBe('s3');
    expect(index.sceneFor(outline('o2', 2))?.id).toBe('s2');
  });

  it('never pairs an outline with a scene generated for a different outline', () => {
    const index = indexScenesByOutline([{ id: 's2', outlineId: 'o2', order: 1 }]);

    expect(index.sceneFor(outline('o1', 1))).toBeUndefined();
  });

  it('falls back to order only for scenes that carry no outline id', () => {
    const index = indexScenesByOutline([
      { id: 'legacy', order: 1 },
      { id: 's2', outlineId: 'o2', order: 2 },
    ]);

    expect(index.sceneFor(outline('o1', 1))?.id).toBe('legacy');
    expect(index.sceneFor(outline('o2', 2))?.id).toBe('s2');
  });
});
