import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectDocumentMediaRefs } from '@/lib/media/document-media-refs';
import { stageAssetDir } from '@/lib/persistence/git-sync-assets';

describe('stageAssetDir', () => {
  it('leaves ordinary stage ids as they are', () => {
    expect(stageAssetDir('abc123_-XYZ')).toBe(path.join('assets', 'abc123_-XYZ'));
  });

  it.each(['..', '.', '...', '../..', 'a/../..', 'a\..\b', ''])(
    'keeps %j one level below assets/',
    (stageId) => {
      const resolved = path.resolve('/repo', stageAssetDir(stageId));
      expect(path.dirname(resolved)).toBe(path.resolve('/repo/assets'));
    },
  );
});

describe('collectDocumentMediaRefs', () => {
  it('does not treat dot-only values as media refs', () => {
    const refs = collectDocumentMediaRefs({
      scenes: [{ elements: [{ src: '..' }, { src: '.' }, { src: 'img_1.png' }] }],
    });
    expect(refs).toEqual(['img_1.png']);
  });
});
