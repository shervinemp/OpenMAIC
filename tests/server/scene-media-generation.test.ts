import { describe, expect, it } from 'vitest';

import { mediaBytes, replaceMediaRefs } from '@/lib/server/scene-media-generation';

describe('mediaBytes', () => {
  it('decodes inline base64 data URIs even when the base64 has line breaks', async () => {
    const expected = Buffer.from('a real generated video');
    const base64 = expected.toString('base64').replace(/(.{8})/g, '$1\n');
    const media = await mediaBytes({ url: `data:video/mp4;base64,${base64}` }, 'video/mp4');
    expect(media.bytes).toEqual(expected);
    expect(media.mimeType).toBe('video/mp4');
  });

  it('decodes non-base64 inline data URIs', async () => {
    const media = await mediaBytes({ url: 'data:text/plain,hello%20world' }, 'text/plain');
    expect(media.bytes.toString()).toBe('hello world');
  });
});

describe('replaceMediaRefs', () => {
  it('rewrites placeholders in nested canvas and action fields', () => {
    const scene = {
      content: {
        type: 'slide',
        canvas: { elements: [{ src: 'gen_img_1', caption: 'see gen_img_1' }] },
      },
      actions: [{ type: 'spotlight', target: 'gen_img_1' }],
    };
    expect(replaceMediaRefs(scene, 'gen_img_1', 'ast_123')).toEqual({
      content: {
        type: 'slide',
        canvas: { elements: [{ src: 'ast_123', caption: 'see ast_123' }] },
      },
      actions: [{ type: 'spotlight', target: 'ast_123' }],
    });
  });

  it('leaves unrelated refs untouched', () => {
    expect(replaceMediaRefs({ src: 'gen_img_2' }, 'gen_img_1', 'ast_123')).toEqual({
      src: 'gen_img_2',
    });
  });
});
