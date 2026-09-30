import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectDocumentMediaRefs } from '@/lib/media/document-media-refs';
import { stageAssetDir } from '@/lib/persistence/git-sync-assets';
import { serverPoolNames } from '@/lib/media/document-media-refs';

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

describe('media refs are media', () => {
  const document = {
    scenes: [
      {
        id: 's1',
        content: {
          canvas: {
            elements: [
              { id: 'text_AbC123xy', type: 'text', content: 'hello' },
              { id: 'img-1', type: 'image', src: 'gen_img_1' },
            ],
          },
        },
        actions: [
          { id: 'a1', type: 'spotlight', elementId: 'text_AbC123xy' },
          { id: 'a2', type: 'speech', text: 'hi', audioId: 'tts_s1_a2' },
        ],
      },
    ],
  };

  it('does not count a canvas element an action points at', () => {
    const refs = collectDocumentMediaRefs(document);
    expect(refs).not.toContain('text_AbC123xy');
    expect(refs.sort()).toEqual(['gen_img_1', 'tts_s1_a2']);
  });

  it('still counts a generation task ref named by elementId', () => {
    const refs = collectDocumentMediaRefs({
      outline: [{ mediaGenerations: [{ elementId: 'gen_vid_2' }] }],
    });
    expect(refs).toEqual(['gen_vid_2']);
  });

  it('looks a task ref up under its course-scoped pool name too', () => {
    expect(serverPoolNames('gen_img_1', 'stage-9')).toEqual(['gen_img_1', 'stage-9:gen_img_1']);
    expect(serverPoolNames('tts_s1_a2', 'stage-9')).toEqual(['tts_s1_a2']);
  });
});

describe('materializeStageAssets finds task refs in the course-scoped pool', () => {
  it('copies the bytes and does not report the ref missing', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maic-mat-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maic-repo-'));
    try {
      await fs.mkdir(path.join(dir, 'assets', '.meta'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'assets', encodeURIComponent('stage-9:gen_img_1')),
        'png-bytes',
      );
      const { materializeStageAssets } = await import('@/lib/persistence/git-sync-assets');

      const result = await materializeStageAssets(dir, repo, 'stage-9', {
        scenes: [{ content: { canvas: { elements: [{ src: 'gen_img_1' }] } } }],
      });

      expect(result.missing).toEqual([]);
      expect(result.mediaIncluded).toBe(1);
      const copied = await fs.readFile(path.join(repo, 'assets', 'stage-9', 'gen_img_1'), 'utf8');
      expect(copied).toBe('png-bytes');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});
