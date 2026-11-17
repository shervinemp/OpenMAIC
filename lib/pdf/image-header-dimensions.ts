/**
 * Intrinsic pixel dimensions of an image, read from its header.
 *
 * Extractors describe images in different units: unpdf reports the decoded
 * bitmap's pixel size, while MinerU reports a page-layout box (PDF points or
 * normalized page coordinates). Downstream code treats `PdfImage.width` and
 * `.height` as pixels — caption-worthiness thresholds, vision-tile budgeting,
 * aspect-ratio hints — so a layout box passed through as if it were pixels
 * silently skips real figures and undercounts vision cost.
 *
 * This reads the size the image itself declares, without decoding its pixels
 * and without a native image library, so the MinerU path can report the same
 * kind of dimensions as every other extractor. It is intentionally tolerant:
 * an unrecognized or truncated header returns `undefined`, and callers leave
 * the dimensions unknown rather than guessing from layout units.
 *
 * Supported: PNG, GIF, BMP, WebP (lossy, lossless, extended), JPEG, JPEG 2000.
 */

export interface ImagePixelDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Headers are near the front of every format here. JPEG is the exception:
 * metadata segments may precede the frame header, so the prefix is generous
 * enough for ordinary EXIF and ICC profiles.
 */
const HEADER_PREFIX_BYTES = 256 * 1024;

/** Base64 characters decode 4 -> 3 bytes; 256 KiB needs ~350k characters. */
function decodeBase64Prefix(base64: string, maxBytes: number): Uint8Array | undefined {
  const bytes = new Uint8Array(maxBytes);
  let written = 0;
  let buffer = 0;
  let bits = 0;

  for (let index = 0; index < base64.length; index++) {
    const code = base64.charCodeAt(index);
    let value: number;

    if (code === 0x3d) break; // '=' padding ends the payload
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code === 0x2b || code === 0x2d)
      value = 62; // '+' or URL-safe '-'
    else if (code === 0x2f || code === 0x5f)
      value = 63; // '/' or URL-safe '_'
    else if (code >= 0x41 && code <= 0x5a) value = code - 0x41;
    else if (code >= 0x61 && code <= 0x7a) value = code - 0x47;
    else if (code >= 0x30 && code <= 0x39) value = code + 0x04;
    else return undefined;

    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written++] = (buffer >> bits) & 0xff;
      if (written === maxBytes) break;
    }
  }

  return written > 0 ? bytes.subarray(0, written) : undefined;
}

/** The base64 payload of a data URL, or a raw base64 string. */
function base64Payload(src: string): string | undefined {
  if (!src.startsWith('data:')) return src;
  const comma = src.indexOf(',');
  if (comma < 0) return undefined;
  // Non-base64 data URLs (SVG text, URL-encoded bytes) are not header-readable.
  if (!/;base64(?:;|$)/i.test(src.slice(5, comma))) return undefined;
  return src.slice(comma + 1);
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function i32le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)
  );
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function checked(width: number, height: number): ImagePixelDimensions | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  // Reject garbage that happens to match a signature; no course image is
  // anywhere near this large.
  if (width > 100_000 || height > 100_000) return undefined;
  return { width, height };
}

function pngDimensions(bytes: Uint8Array): ImagePixelDimensions | undefined {
  if (bytes.length < 24) return undefined;
  if (!asciiAt(bytes, 1, 'PNG') || bytes[0] !== 0x89) return undefined;
  return checked(u32be(bytes, 16), u32be(bytes, 20));
}

function gifDimensions(bytes: Uint8Array): ImagePixelDimensions | undefined {
  if (bytes.length < 10 || !asciiAt(bytes, 0, 'GIF8')) return undefined;
  return checked(u16le(bytes, 6), u16le(bytes, 8));
}

function bmpDimensions(bytes: Uint8Array): ImagePixelDimensions | undefined {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return undefined;
  // A negative height means a top-down bitmap; the magnitude is the size.
  return checked(i32le(bytes, 18), Math.abs(i32le(bytes, 22)));
}

function webpDimensions(bytes: Uint8Array): ImagePixelDimensions | undefined {
  if (bytes.length < 30 || !asciiAt(bytes, 0, 'RIFF') || !asciiAt(bytes, 8, 'WEBP')) {
    return undefined;
  }
  if (asciiAt(bytes, 12, 'VP8X')) {
    // Extended format: 24-bit canvas size minus one, after flags and reserved.
    return checked(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
  }
  if (asciiAt(bytes, 12, 'VP8L')) {
    if (bytes[20] !== 0x2f) return undefined;
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return checked((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (asciiAt(bytes, 12, 'VP8 ')) {
    // Lossy bitstream: frame tag (3) + start code (3), then 14-bit sizes.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
    return checked(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }
  return undefined;
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(bytes: Uint8Array): ImagePixelDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers (SOI, TEM, RSTn) carry no length segment.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) return undefined;
    const segmentLength = u16be(bytes, offset + 2);
    if (segmentLength < 2) return undefined;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) return undefined;
      // precision (1), height (2), width (2) follow the length.
      return checked(u16be(bytes, offset + 7), u16be(bytes, offset + 5));
    }
    offset += 2 + segmentLength;
  }
  return undefined;
}

function jpeg2000Dimensions(bytes: Uint8Array): ImagePixelDimensions | undefined {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0x00 ||
    bytes[1] !== 0x00 ||
    bytes[2] !== 0x00 ||
    bytes[3] !== 0x0c ||
    !asciiAt(bytes, 4, 'jP  ')
  ) {
    return undefined;
  }
  // The image header box is 'ihdr' followed by height then width, both 32-bit
  // big-endian. It lives in the early header; a short scan is enough.
  const limit = Math.min(bytes.length - 12, 4096);
  for (let offset = 0; offset < limit; offset++) {
    if (!asciiAt(bytes, offset, 'ihdr')) continue;
    return checked(u32be(bytes, offset + 8), u32be(bytes, offset + 4));
  }
  return undefined;
}

/**
 * The intrinsic pixel size declared by an image data URL (or raw base64), or
 * `undefined` when the format is unsupported or the header is incomplete.
 * `width`/`height` are true pixel dimensions — never page-layout units.
 */
export function imageDimensionsFromDataUrl(src: string): ImagePixelDimensions | undefined {
  if (!src) return undefined;
  const payload = base64Payload(src);
  if (!payload) return undefined;
  const bytes = decodeBase64Prefix(payload, HEADER_PREFIX_BYTES);
  if (!bytes) return undefined;

  return (
    pngDimensions(bytes) ??
    gifDimensions(bytes) ??
    bmpDimensions(bytes) ??
    webpDimensions(bytes) ??
    jpegDimensions(bytes) ??
    jpeg2000Dimensions(bytes)
  );
}
