import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_INDEX_KEY_VERSION,
  buildDocumentIndexHandle,
} from '@/lib/server/document-index-store';

const images = [
  {
    id: 'img_2',
    pageNumber: 2,
    width: 640,
    height: 480,
    description: 'A chart',
    src: 'data:image/png;base64,BBBB',
  },
  {
    id: 'img_1',
    pageNumber: 1,
    width: 320,
    height: 200,
    description: 'A diagram',
    src: 'data:image/png;base64,AAAA',
  },
];

const base = {
  text: 'The same extracted document text.',
  language: 'English',
  modelString: 'openai:gpt-test',
  images,
};

describe('buildDocumentIndexHandle', () => {
  it('is stable for identical inputs, regardless of image order', () => {
    expect(buildDocumentIndexHandle(base)).toBe(
      buildDocumentIndexHandle({ ...base, images: [...images].reverse() }),
    );
  });

  it('changes when the text changes', () => {
    expect(buildDocumentIndexHandle({ ...base, text: 'Different text.' })).not.toBe(
      buildDocumentIndexHandle(base),
    );
  });

  it('keys captions/digests by language', () => {
    expect(buildDocumentIndexHandle({ ...base, language: 'Chinese' })).not.toBe(
      buildDocumentIndexHandle(base),
    );
  });

  it('keys captions/digests by model', () => {
    expect(buildDocumentIndexHandle({ ...base, modelString: 'anthropic:claude-test' })).not.toBe(
      buildDocumentIndexHandle(base),
    );
  });

  it('keys captions by the actual image bytes, not just the id', () => {
    const changed = images.map((image) =>
      image.id === 'img_1' ? { ...image, src: 'data:image/png;base64,CCCC' } : image,
    );
    expect(buildDocumentIndexHandle({ ...base, images: changed })).not.toBe(
      buildDocumentIndexHandle(base),
    );
  });

  it('keys captions by image metadata', () => {
    const changed = images.map((image) =>
      image.id === 'img_1' ? { ...image, description: 'A different description' } : image,
    );
    expect(buildDocumentIndexHandle({ ...base, images: changed })).not.toBe(
      buildDocumentIndexHandle(base),
    );
  });

  it('carries the key version so prompt/schema changes invalidate old variants', () => {
    expect(DOCUMENT_INDEX_KEY_VERSION).toBeGreaterThanOrEqual(2);
    expect(buildDocumentIndexHandle(base)).toMatch(/^[a-f0-9]{64}$/);
  });
});
