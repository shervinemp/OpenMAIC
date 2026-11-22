/**
 * Server-side document index store (Phase 2 §16).
 *
 * The full extracted source text, its retrieval chunks, the coverage digest,
 * and the image captions live here — keyed by the content hash of the text —
 * so no stage ever ships the raw document through a client payload again.
 * The client session carries only the handle (+ the small digest).
 *
 * Layout: `<PERSISTENCE_DIR>/doc-index/<sha256>.json` (one file per document,
 * temp-write + atomic rename like the runtime file store). When
 * PERSISTENCE_DIR is unset the store falls back to an in-memory map —
 * graceful degradation: a restart simply rebuilds the index on demand.
 *
 * Server-only module (node:fs/promises) — never imported from client code.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DocumentDigest } from '@/lib/generation/document-digest';
import type { ImageCaption } from '@/lib/generation/image-captioning';
import type { PdfChunk } from '@openmaic/generation';

/**
 * Bumped whenever the index prompt/schema changes in a way that makes an old
 * digest or caption set stale. It is part of the handle, so old entries are
 * left untouched and a new request builds a new variant.
 */
export const DOCUMENT_INDEX_KEY_VERSION = 2;

export interface DocumentIndexImageIdentity {
  id?: string;
  pageNumber?: number;
  width?: number;
  height?: number;
  description?: string;
  src?: string;
}

export interface DocumentIndexIdentity {
  text: string;
  language?: string;
  modelString?: string;
  /**
   * The model that captions images, when it differs from the digest model.
   * Captions are half the cached payload, so a different captioner must not
   * reuse another model's captions.
   */
  captionModelString?: string;
  images?: readonly DocumentIndexImageIdentity[];
}

/**
 * Stable handle for one index VARIANT.
 *
 * The old key was `sha256(text)` only, so the same document re-used an index
 * built in another language, with another model, or with a different image
 * set. The digest and captions are all language/model/image dependent, so the
 * handle must be too. The text itself is still part of the hash; the other
 * fields only distinguish variants that must not share an entry.
 */
export function buildDocumentIndexHandle(identity: DocumentIndexIdentity): string {
  const hash = createHash('sha256');
  hash.update(`openmaic-doc-index:v${DOCUMENT_INDEX_KEY_VERSION}\n`);
  hash.update(`language:${identity.language ?? 'English'}\n`);
  hash.update(`model:${identity.modelString ?? ''}\n`);
  // Only a SEPARATE caption model is a variant: the default path (captions on
  // the digest model) must keep producing the same handle it always has.
  hash.update(
    `captionModel:${
      identity.captionModelString && identity.captionModelString !== identity.modelString
        ? identity.captionModelString
        : ''
    }\n`,
  );
  const images = [...(identity.images ?? [])].sort((left, right) =>
    String(left.id ?? '').localeCompare(String(right.id ?? '')),
  );
  hash.update(`images:${images.length}\n`);
  for (const image of images) {
    // `src` is what the captioner actually sees, so a different byte stream
    // with the same id/metadata must not share captions.
    hash.update(
      JSON.stringify([
        image.id ?? '',
        image.pageNumber ?? 0,
        image.width ?? 0,
        image.height ?? 0,
        image.description ?? '',
        image.src ?? '',
      ]),
    );
    hash.update('\n');
  }
  hash.update('text:\n');
  hash.update(identity.text);
  return hash.digest('hex');
}

export interface StoredDocumentIndex {
  version: 1;
  /** Variant hash (text + language + model + images) - the handle clients keep. */
  handle: string;
  /** Language used for the digest/captions (absent on legacy entries). */
  language?: string;
  /** Model string used to build the digest/captions (absent on legacy entries). */
  modelString?: string;
  /** Model string used for captions when it differs from the digest model. */
  captionModelString?: string;
  /** Key derivation version (absent on legacy entries). */
  keyVersion?: number;
  /** Full extracted text, unmodified (noise stripping happens on load). */
  text: string;
  /** Chunks of the noise-stripped text (the retrieval index). */
  chunks: PdfChunk[];
  /** Coverage digest; sections may be empty when the raw tier applied. */
  digest: DocumentDigest;
  /** Captions by image id (all images that were successfully captioned). */
  captions: Record<string, ImageCaption>;
  /** Tier used at build time ('raw' | 'single' | 'two-level'). */
  tier: string;
  totalImageCount: number;
  captionedCount: number;
  createdAt: string;
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function indexDir(): string | null {
  const dir = process.env.PERSISTENCE_DIR;
  return dir ? join(dir, 'doc-index') : null;
}

function indexPath(handle: string): string | null {
  const dir = indexDir();
  return dir ? join(dir, `${handle}.json`) : null;
}

const memoryStore = new Map<string, StoredDocumentIndex>();
/** A full index can be megabytes; cap the in-memory layer so a long-lived
 *  process cannot grow without bound. The file store remains authoritative. */
const MEMORY_INDEX_LIMIT = 12;

function remember(handle: string, index: StoredDocumentIndex): void {
  memoryStore.delete(handle);
  memoryStore.set(handle, index);
  while (memoryStore.size > MEMORY_INDEX_LIMIT) {
    const oldest = memoryStore.keys().next();
    if (oldest.done) break;
    memoryStore.delete(oldest.value);
  }
}

export async function loadDocumentIndex(handle: string): Promise<StoredDocumentIndex | null> {
  const memoryHit = memoryStore.get(handle);
  if (memoryHit) {
    remember(handle, memoryHit);
    return memoryHit;
  }

  const path = indexPath(handle);
  if (!path) return null;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as StoredDocumentIndex;
    if (parsed.version !== 1 || parsed.handle !== handle) return null;
    remember(handle, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export async function saveDocumentIndex(index: StoredDocumentIndex): Promise<void> {
  remember(index.handle, index);
  const path = indexPath(index.handle);
  if (!path) return;

  await mkdir(join(path, '..'), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(index), 'utf8');
  await rename(tempPath, path);
}

export async function documentIndexExists(handle: string): Promise<boolean> {
  if (memoryStore.has(handle)) return true;
  const path = indexPath(handle);
  if (!path) return false;
  try {
    await readFile(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}
