import { describe, expect, it } from 'vitest';

import { replaceMediaRefs } from '@/lib/server/scene-media-generation';

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
