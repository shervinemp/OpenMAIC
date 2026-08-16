import { describe, expect, test } from 'vitest';
import {
  buildCaptionPrompt,
  captionDocumentImages,
  parseCaptionResponse,
  planCaptionBatches,
} from '@/lib/generation/image-captioning';
import { CAPTION_BATCH_IMAGES } from '@/lib/constants/generation';

function images(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `img_${i + 1}`,
    src: `data:image/png;base64,AA==`,
    pageNumber: i + 1,
  }));
}

describe('planCaptionBatches', () => {
  test('batches all images, ordered by page, within batch size', () => {
    const batches = planCaptionBatches(images(23));
    expect(batches.length).toBe(3);
    expect(batches[0]).toHaveLength(CAPTION_BATCH_IMAGES);
    expect(batches[1]).toHaveLength(CAPTION_BATCH_IMAGES);
    expect(batches[2]).toHaveLength(3);
    expect(batches.flat()).toHaveLength(23);
  });

  test('empty input yields no batches', () => {
    expect(planCaptionBatches([])).toEqual([]);
  });
});

describe('buildCaptionPrompt', () => {
  test('labels every image with its page', () => {
    const prompt = buildCaptionPrompt(images(2), 'English');
    expect(prompt.user).toContain('img_1 (document page 1)');
    expect(prompt.user).toContain('img_2 (document page 2)');
    expect(prompt.system).toContain('diagram');
  });
});

describe('parseCaptionResponse', () => {
  test('parses valid captions, normalizes unknown kinds, drops foreign ids', () => {
    const captions = parseCaptionResponse(
      JSON.stringify({
        images: [
          { id: 'img_1', caption: 'A memory hierarchy diagram', kind: 'diagram' },
          { id: 'img_2', caption: 'A photo of a server rack', kind: 'photo' },
          { id: 'img_3', caption: 'Something weird', kind: 'hologram' },
          { id: 'img_99', caption: 'Not in this batch' },
          { id: 'img_4', caption: '' },
        ],
      }),
      ['img_1', 'img_2', 'img_3', 'img_4'],
    );
    expect(captions).toHaveLength(3);
    expect(captions.find((c) => c.id === 'img_1')?.kind).toBe('diagram');
    expect(captions.find((c) => c.id === 'img_3')?.kind).toBe('other');
    expect(captions.some((c) => c.id === 'img_99')).toBe(false);
    expect(captions.some((c) => c.id === 'img_4')).toBe(false);
  });

  test('rejects garbage', () => {
    expect(parseCaptionResponse('not json', ['img_1'])).toEqual([]);
    expect(parseCaptionResponse('{"images": 5}', ['img_1'])).toEqual([]);
  });
});

describe('captionDocumentImages', () => {
  test('captions every batch and returns captions by id', async () => {
    const batchLog: number[] = [];
    const captions = await captionDocumentImages(images(23), {
      aiCall: async (_system, _user, batchImages) => {
        batchLog.push(batchImages?.length ?? 0);
        return JSON.stringify({
          images: (batchImages ?? []).map((img) => ({
            id: img.id,
            caption: `Caption for ${img.id}`,
            kind: 'diagram',
          })),
        });
      },
      onProgress: () => {},
    });
    expect(batchLog).toEqual([10, 10, 3]);
    expect(captions.size).toBe(23);
    expect(captions.get('img_1')?.caption).toBe('Caption for img_1');
  });

  test('a failed batch leaves its ids uncaptioned without failing the pass', async () => {
    const captions = await captionDocumentImages(images(5), {
      batchSize: 3,
      aiCall: async () => 'garbage',
    });
    expect(captions.size).toBe(0);
  });
});
