import { describe, expect, it } from 'vitest';
import { extractMinerUResult } from '@/lib/pdf/mineru-parser';

function pngBase64(width: number, height: number): string {
  const bytes = new Uint8Array(26);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  const write = (offset: number, value: number) => {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
  };
  write(16, width);
  write(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return Buffer.from(bytes).toString('base64');
}

describe('MinerU image dimensions', () => {
  it('reports intrinsic pixels, not the content_list layout box', () => {
    const parsed = extractMinerUResult({
      md_content: '# Page',
      images: { 'figures/water.png': pngBase64(640, 480) },
      content_list: [
        {
          type: 'image',
          img_path: 'figures/water.png',
          page_idx: 2,
          // Page coordinates: a layout box must not become width/height.
          bbox: [100, 200, 180, 260],
          image_caption: ['A labelled water cycle'],
        },
      ],
    });

    expect(parsed.metadata?.pdfImages).toEqual([
      {
        id: 'img_1',
        src: expect.stringContaining('data:image/png;base64,'),
        pageNumber: 3,
        description: 'A labelled water cycle',
        width: 640,
        height: 480,
      },
    ]);
  });

  it('leaves dimensions unknown when the image header is unreadable', () => {
    const parsed = extractMinerUResult({
      md_content: '',
      images: { 'figures/unknown.tiff': Buffer.from([0x49, 0x49, 0x2a, 0x00]).toString('base64') },
      content_list: [
        { type: 'image', img_path: 'figures/unknown.tiff', page_idx: 0, bbox: [0, 0, 200, 100] },
      ],
    });

    const image = parsed.metadata?.pdfImages?.[0];
    expect(image).toMatchObject({ id: 'img_1', pageNumber: 1 });
    expect(image?.width).toBeUndefined();
    expect(image?.height).toBeUndefined();
  });

  it('keeps page numbering and captions when content_list is absent', () => {
    const parsed = extractMinerUResult({
      md_content: '',
      images: { 'a.png': pngBase64(32, 32) },
    });

    expect(parsed.metadata?.pdfImages?.[0]).toMatchObject({
      id: 'img_1',
      pageNumber: 0,
      width: 32,
      height: 32,
    });
  });
});
