import { describe, expect, test } from 'vitest';
import {
  buildCaptionPrompt,
  captionDocumentImages,
  captionImageTiles,
  isCaptionWorthyImage,
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

function sizedImages(count: number, width: number, height: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `img_${i + 1}`,
    src: 'data:image/png;base64,AA==',
    pageNumber: i + 1,
    width,
    height,
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

  test('bounds a batch by estimated vision tiles, not only by count', () => {
    // 4096×3072 = 4×3 = 12 tiles per image; the 40-tile budget admits three.
    const batches = planCaptionBatches(sizedImages(8, 4096, 3072));
    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 2]);
  });

  test('admits the first image even when it exceeds the whole tile budget', () => {
    const batches = planCaptionBatches([
      { id: 'huge', pageNumber: 1, width: 20_000, height: 15_000 },
    ]);
    expect(batches).toEqual([['huge']]);
  });

  test('orders by page before applying the tile budget', () => {
    const batches = planCaptionBatches([
      { id: 'late', pageNumber: 3, width: 4096, height: 3072 },
      { id: 'early', pageNumber: 1, width: 256, height: 256 },
    ]);
    expect(batches.flat()).toEqual(['early', 'late']);
  });

  test('unknown dimensions keep the count-based batch size', () => {
    expect(planCaptionBatches(images(23)).map((batch) => batch.length)).toEqual([10, 10, 3]);
    expect(captionImageTiles({ width: undefined, height: undefined })).toBe(1);
  });
});

describe('caption worthiness', () => {
  test('skips icons and fixed-size decorations', () => {
    expect(isCaptionWorthyImage({ width: 32, height: 32 })).toBe(false);
    expect(isCaptionWorthyImage({ width: 100, height: 100 })).toBe(false);
    expect(isCaptionWorthyImage({ width: 48, height: 800 })).toBe(false);
    expect(isCaptionWorthyImage({ width: 800, height: 600 })).toBe(true);
    expect(isCaptionWorthyImage({ width: 128, height: 128 })).toBe(true);
  });

  test('unmeasured images stay eligible', () => {
    expect(isCaptionWorthyImage({ width: undefined, height: undefined })).toBe(true);
    expect(isCaptionWorthyImage({ width: Number.NaN, height: 800 })).toBe(true);
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

  test('skips icon-sized images and captions only substantive ones', async () => {
    const seen: string[] = [];
    const captions = await captionDocumentImages(
      [
        { id: 'icon', src: 'data:image/png;base64,AA==', pageNumber: 1, width: 32, height: 32 },
        { id: 'rule', src: 'data:image/png;base64,AA==', pageNumber: 2, width: 48, height: 800 },
        { id: 'chart', src: 'data:image/png;base64,AA==', pageNumber: 3, width: 800, height: 600 },
      ],
      {
        aiCall: async (_system, _user, batchImages) => {
          seen.push(...(batchImages ?? []).map((image) => image.id));
          return JSON.stringify({
            images: (batchImages ?? []).map((image) => ({
              id: image.id,
              caption: `Caption for ${image.id}`,
              kind: 'diagram',
            })),
          });
        },
      },
    );

    expect(seen).toEqual(['chart']);
    expect([...captions.keys()]).toEqual(['chart']);
  });

  test('makes no vision call when every image is a decoration', async () => {
    let calls = 0;
    const captions = await captionDocumentImages(
      [{ id: 'icon', src: 'data:image/png;base64,AA==', pageNumber: 1, width: 16, height: 16 }],
      {
        aiCall: async () => {
          calls += 1;
          return '{}';
        },
      },
    );

    expect(calls).toBe(0);
    expect(captions.size).toBe(0);
  });

  test('still captions images whose dimensions are unknown', async () => {
    let calls = 0;
    const captions = await captionDocumentImages(images(1), {
      aiCall: async (_system, _user, batchImages) => {
        calls += 1;
        return JSON.stringify({
          images: (batchImages ?? []).map((image) => ({
            id: image.id,
            caption: 'A diagram',
            kind: 'diagram',
          })),
        });
      },
    });

    expect(calls).toBe(1);
    expect(captions.get('img_1')?.caption).toBe('A diagram');
  });
});
