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
import type { PdfChunk } from '@/lib/generation/pdf-retrieval';

export interface StoredDocumentIndex {
  version: 1;
  /** sha256 of the raw extracted text — the handle clients keep. */
  handle: string;
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

export async function loadDocumentIndex(handle: string): Promise<StoredDocumentIndex | null> {
  const memoryHit = memoryStore.get(handle);
  if (memoryHit) return memoryHit;

  const path = indexPath(handle);
  if (!path) return null;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as StoredDocumentIndex;
    if (parsed.version !== 1 || parsed.handle !== handle) return null;
    memoryStore.set(handle, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export async function saveDocumentIndex(index: StoredDocumentIndex): Promise<void> {
  memoryStore.set(index.handle, index);
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
