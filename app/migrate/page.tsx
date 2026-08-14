'use client';

/**
 * /migrate — one-time import for data exported by `scripts/run-migration.mjs`
 * (which reads the source browser profile's storage at the OLD origin).
 *
 * Everything lands in the LOCAL server store on this machine (origin-
 * independent — no browser origin is touched as a destination):
 *
 * 1. Documents → /api/persistence (validated, stored on disk under
 *    `.data/persistence/documents/`).
 * 2. Media assets → /api/persistence/assets (bytes on disk under
 *    `.data/persistence/assets/`, refs preserved exactly).
 * 3. localStorage (settings KV, provider config, learner key, …) → the
 *    current origin's localStorage.
 */
import { useState } from 'react';
import { HttpDocumentStore } from '@openmaic/storage';

import { getLearnerKey } from '@/lib/runtime/learner-key';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';

interface ImportReport {
  documents: { total: number; ok: number; failed: Array<{ id: string; error: string }> };
  assets: { total: number; ok: number; skipped: number };
  localStorageKeys: number;
  preservedDatabases: string[];
}

interface MigrationFile {
  app?: unknown;
  kind?: unknown;
  origin?: unknown;
  exportedAt?: unknown;
  databases?: Array<{ name?: unknown; stores?: Record<string, Array<[string, unknown]>> }>;
  localStorage?: Record<string, string | null>;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isBinValue(value: unknown): value is { $bin: string } {
  return (
    typeof value === 'object' && value !== null && typeof (value as { $bin?: unknown }).$bin === 'string'
  );
}

async function authHeaders(): Promise<Record<string, string>> {
  const learnerKey = await getLearnerKey();
  const token = process.env.NEXT_PUBLIC_PERSISTENCE_TOKEN;
  return {
    'x-learner-key': learnerKey,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

interface DocAggregate {
  stage: Record<string, unknown>;
  scenes: unknown[];
  outline?: unknown;
}

/** Reassemble documents from a store set with `stages`/`scenes`/`outlines`. */
function documentsFromStores(stores: Record<string, Array<[string, unknown]>>): DocAggregate[] {
  const stages = (stores.stages ?? []).map(([, v]) => v as Record<string, unknown>);
  const scenesByStage = new Map<string, unknown[]>();
  for (const [, scene] of stores.scenes ?? []) {
    const value = scene as { stageId?: unknown } | null;
    const stageId = value && typeof value === 'object' ? value.stageId : undefined;
    if (typeof stageId !== 'string') continue;
    if (!scenesByStage.has(stageId)) scenesByStage.set(stageId, []);
    scenesByStage.get(stageId)!.push(scene);
  }
  const outlinesByStage = new Map<string, unknown>(
    (stores.outlines ?? [])
      .map(([, v]) => [((v as { stageId?: unknown })?.stageId ?? ''), v] as [string, unknown])
      .filter(([id]) => id !== ''),
  );
  const documents: DocAggregate[] = [];
  for (const stage of stages) {
    const id = stage?.id;
    if (typeof id !== 'string') continue;
    const outline = outlinesByStage.get(id);
    documents.push({
      stage,
      scenes: scenesByStage.get(id) ?? [],
      ...(outline ? { outline } : {}),
    });
  }
  return documents;
}

/** Rows usable as an asset pool: `assets` entries + `blobs` bytes by hash. */
function assetPoolFromStores(stores: Record<string, Array<[string, unknown]>>): {
  assets: Array<[string, { contentHash?: unknown; mime?: unknown; meta?: unknown }]>;
  blobs: Map<string, Uint8Array>;
} {
  const blobs = new Map<string, Uint8Array>();
  for (const [hash, value] of stores.blobs ?? []) {
    if (typeof hash !== 'string' || !isBinValue(value)) continue;
    blobs.set(hash, base64ToBytes(value.$bin));
  }
  const assets: Array<[string, { contentHash?: unknown; mime?: unknown; meta?: unknown }]> = [];
  for (const [assetId, value] of stores.assets ?? []) {
    if (typeof assetId !== 'string' || typeof value !== 'object' || value === null) continue;
    assets.push([assetId, value as { contentHash?: unknown; mime?: unknown; meta?: unknown }]);
  }
  return { assets, blobs };
}

async function putAssetToServer(
  ref: string,
  bytes: Uint8Array,
  mime: string,
  meta: unknown,
): Promise<void> {
  const headers = await authHeaders();
  headers['content-type'] = mime || 'application/octet-stream';
  if (meta !== undefined && typeof meta === 'object' && meta !== null && Object.keys(meta).length > 0) {
    headers['x-asset-meta'] = btoa(unescape(encodeURIComponent(JSON.stringify(meta))));
  }
  const response = await fetch(`/api/persistence/assets/${encodeURIComponent(ref)}`, {
    method: 'PUT',
    headers,
    body: bytes.buffer as ArrayBuffer,
  });
  if (!response.ok) {
    throw new Error(`asset upload failed (HTTP ${response.status})`);
  }
}

export default function MigratePage() {
  const [report, setReport] = useState<ImportReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File): Promise<void> {
    setRunning(true);
    setError(null);
    setReport(null);
    const next: ImportReport = {
      documents: { total: 0, ok: 0, failed: [] },
      assets: { total: 0, ok: 0, skipped: 0 },
      localStorageKeys: 0,
      preservedDatabases: [],
    };
    try {
      const data = JSON.parse(await file.text()) as MigrationFile;
      if (data.app !== 'openmaic' || data.kind !== 'origin-migration') {
        throw new Error('This file is not an OpenMAIC origin-migration export.');
      }

      const dbs = data.databases ?? [];

      // 1. Documents → server-backed persistence (origin-independent).
      const documentStore = new HttpDocumentStore({
        baseUrl: '/api/persistence',
        headers: authHeaders,
        validateScene: validateAppScene,
        validateStage: validateAppStage,
      });
      const seenStageIds = new Set<string>();
      const documents: DocAggregate[] = [];
      for (const db of dbs) {
        if (!db.stores) continue;
        const found = documentsFromStores(db.stores);
        for (const doc of found) {
          const id = String(doc.stage.id);
          if (seenStageIds.has(id)) continue;
          seenStageIds.add(id);
          documents.push(doc);
        }
        if (db.name !== 'maic-documents' && found.length > 0) {
          next.preservedDatabases.push(String(db.name ?? '?'));
        }
      }
      next.documents.total = documents.length;
      for (const doc of documents) {
        const id = String(doc.stage.id);
        try {
          await documentStore.saveDocument(doc as { stage: never; scenes: never[]; outline?: unknown });
          next.documents.ok++;
        } catch (cause) {
          next.documents.failed.push({
            id,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }

      // 2. Media assets → server disk, refs preserved exactly.
      for (const db of dbs) {
        if (!db.stores) continue;
        const { assets, blobs } = assetPoolFromStores(db.stores);
        if (assets.length === 0 && blobs.size === 0) continue;
        next.assets.total += assets.length;
        for (const [assetId, entry] of assets) {
          const hash = entry.contentHash;
          if (typeof hash !== 'string') {
            next.assets.skipped++;
            continue;
          }
          const bytes = blobs.get(hash);
          if (!bytes) {
            next.assets.skipped++;
            continue;
          }
          try {
            await putAssetToServer(
              assetId,
              bytes,
              typeof entry.mime === 'string' ? entry.mime : '',
              entry.meta,
            );
            next.assets.ok++;
          } catch (cause) {
            next.assets.skipped++;
            console.error(`asset ${assetId} failed`, cause);
          }
        }
      }

      // 3. localStorage → this origin.
      const local = data.localStorage ?? {};
      for (const [key, value] of Object.entries(local)) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
      next.localStorageKeys = Object.keys(local).length;

      setReport(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  }

  return (
    <main style={{ maxWidth: 680, margin: '48px auto', padding: '0 16px', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Import previous OpenMAIC data</h1>
      <p>
        Pick the <code>openmaic-migration.json</code> file exported by{' '}
        <code>scripts/run-migration.mjs</code>. Documents and media assets are
        written to the server-backed store on this machine (disk); settings are
        written into this origin&apos;s localStorage.
      </p>
      <input
        type="file"
        accept="application/json,.json"
        disabled={running}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
      {running && <p>Importing…</p>}
      {error && <p style={{ color: '#b00020', whiteSpace: 'pre-wrap' }}>{error}</p>}
      {report && (
        <pre style={{ background: '#f6f6f6', padding: 16, borderRadius: 8, overflowX: 'auto' }}>
{`Documents: ${report.documents.ok}/${report.documents.total} imported
Assets:    ${report.assets.ok}/${report.assets.total} uploaded${report.assets.skipped ? ` (${report.assets.skipped} skipped)` : ''}
Settings:  ${report.localStorageKeys} localStorage keys restored`}
{report.documents.failed.length > 0
  ? `\nFailed documents:\n${report.documents.failed
      .map((f) => `  ${f.id}: ${f.error}`)
      .join('\n')}`
  : ''}
{report.preservedDatabases.length > 0
  ? `\nPreserved (not restored, schema unknown): ${report.preservedDatabases.join(', ')}`
  : ''}
{`\nDone — reload the app to see your lessons.`}
        </pre>
      )}
    </main>
  );
}
