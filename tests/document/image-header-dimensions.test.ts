import { describe, expect, it } from 'vitest';
import { imageDimensionsFromDataUrl } from '@/lib/pdf/image-header-dimensions';

function dataUrl(bytes: ArrayLike<number>, mime = 'image/png'): string {
  return `data:${mime};base64,${Buffer.from(Array.from(bytes)).toString('base64')}`;
}

function writeU16le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function writeU24le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
}

function writeU32be(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function ascii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index++) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(26);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  ascii(bytes, 12, 'IHDR');
  writeU32be(bytes, 16, width);
  writeU32be(bytes, 20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  ascii(bytes, 0, 'GIF89a');
  writeU16le(bytes, 6, width);
  writeU16le(bytes, 8, height);
  return bytes;
}

function bmp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(26);
  ascii(bytes, 0, 'BM');
  bytes[18] = width & 0xff;
  bytes[19] = (width >> 8) & 0xff;
  bytes[20] = (width >> 16) & 0xff;
  bytes[21] = (width >>> 24) & 0xff;
  bytes[22] = height & 0xff;
  bytes[23] = (height >> 8) & 0xff;
  bytes[24] = (height >> 16) & 0xff;
  bytes[25] = (height >>> 24) & 0xff;
  return bytes;
}

function webpExtended(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  ascii(bytes, 0, 'RIFF');
  ascii(bytes, 8, 'WEBP');
  ascii(bytes, 12, 'VP8X');
  bytes[20] = 0; // flags
  writeU24le(bytes, 24, width - 1);
  writeU24le(bytes, 27, height - 1);
  return bytes;
}

function webpLossless(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  ascii(bytes, 0, 'RIFF');
  ascii(bytes, 8, 'WEBP');
  ascii(bytes, 12, 'VP8L');
  bytes[20] = 0x2f;
  const bits = (width - 1) | ((height - 1) << 14);
  bytes[21] = bits & 0xff;
  bytes[22] = (bits >>> 8) & 0xff;
  bytes[23] = (bits >>> 16) & 0xff;
  bytes[24] = (bits >>> 24) & 0xff;
  return bytes;
}

function webpLossy(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  ascii(bytes, 0, 'RIFF');
  ascii(bytes, 8, 'WEBP');
  ascii(bytes, 12, 'VP8 ');
  bytes[23] = 0x9d;
  bytes[24] = 0x01;
  bytes[25] = 0x2a;
  writeU16le(bytes, 26, width);
  writeU16le(bytes, 28, height);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  const bytes: number[] = [0xff, 0xd8];
  // APP0 with a 16-byte segment (length includes the two length bytes).
  bytes.push(0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0));
  // SOF0: length 17, precision 8, height, width, three components.
  bytes.push(
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    ...new Array<number>(9).fill(0),
  );
  bytes.push(0xff, 0xd9);
  return new Uint8Array(bytes);
}

function jpeg2000(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x00, 0x00, 0x00, 0x0c], 0);
  ascii(bytes, 4, 'jP  ');
  bytes.set([0x0d, 0x0a, 0x87, 0x0a], 8);
  bytes.set([0x00, 0x00, 0x00, 0x16], 12);
  ascii(bytes, 16, 'ihdr');
  writeU32be(bytes, 20, height);
  writeU32be(bytes, 24, width);
  bytes.set([0x00, 0x02, 0x07, 0x01, 0x01, 0x00], 28);
  return bytes;
}

describe('imageDimensionsFromDataUrl', () => {
  it('reads PNG dimensions from the IHDR chunk', () => {
    expect(imageDimensionsFromDataUrl(dataUrl(png(640, 480)))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('reads GIF, BMP, WebP and JPEG 2000 dimensions', () => {
    expect(imageDimensionsFromDataUrl(dataUrl(gif(320, 200), 'image/gif'))).toEqual({
      width: 320,
      height: 200,
    });
    expect(imageDimensionsFromDataUrl(dataUrl(bmp(800, 600), 'image/bmp'))).toEqual({
      width: 800,
      height: 600,
    });
    expect(imageDimensionsFromDataUrl(dataUrl(webpExtended(1024, 768), 'image/webp'))).toEqual({
      width: 1024,
      height: 768,
    });
    expect(imageDimensionsFromDataUrl(dataUrl(webpLossless(333, 222), 'image/webp'))).toEqual({
      width: 333,
      height: 222,
    });
    expect(imageDimensionsFromDataUrl(dataUrl(webpLossy(512, 384), 'image/webp'))).toEqual({
      width: 512,
      height: 384,
    });
    expect(imageDimensionsFromDataUrl(dataUrl(jpeg2000(300, 200), 'image/jp2'))).toEqual({
      width: 300,
      height: 200,
    });
  });

  it('reads JPEG dimensions past leading metadata segments', () => {
    expect(imageDimensionsFromDataUrl(dataUrl(jpeg(2048, 1536), 'image/jpeg'))).toEqual({
      width: 2048,
      height: 1536,
    });
  });

  it('accepts raw base64 as well as a data URL', () => {
    const raw = Buffer.from(Array.from(png(1200, 900))).toString('base64');
    expect(imageDimensionsFromDataUrl(raw)).toEqual({ width: 1200, height: 900 });
  });

  it('returns undefined for non-base64 data URLs and unreadable headers', () => {
    expect(imageDimensionsFromDataUrl('data:image/svg+xml,<svg/>')).toBeUndefined();
    expect(imageDimensionsFromDataUrl('https://cdn.example.com/a.png')).toBeUndefined();
    expect(imageDimensionsFromDataUrl(dataUrl([0x41, 0x42, 0x43]))).toBeUndefined();
    expect(imageDimensionsFromDataUrl(dataUrl(png(640, 480).slice(0, 12)))).toBeUndefined();
    expect(imageDimensionsFromDataUrl('')).toBeUndefined();
  });

  it('rejects zero and implausible dimensions', () => {
    expect(imageDimensionsFromDataUrl(dataUrl(png(0, 480)))).toBeUndefined();
    expect(imageDimensionsFromDataUrl(dataUrl(png(640, 0)))).toBeUndefined();
    expect(imageDimensionsFromDataUrl(dataUrl(png(200_000, 480)))).toBeUndefined();
  });
});
