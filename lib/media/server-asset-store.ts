/**
 * HttpAssetStore — a server-backed `StorageProvider` for local self-hosting.
 *
 * The browser counterpart (`BrowserAssetStore`) keeps media bytes in
 * origin-scoped IndexedDB; this store keeps them on the OpenMAIC server's
 * disk (`.data/persistence/assets/`), so generated images/audio/video survive
 * port changes, hostname changes, and browser profile wipes — the same
 * origin-independence the server-backed document store provides for lessons.
 *
 * The media ref domain is unchanged: the store allocates ids via the package's
 * secure id source, and existing documents keep working because refs are
 * opaque strings. `resolve` fetches the bytes and mints an object URL.
 *
 * Only used when `NEXT_PUBLIC_PERSISTENCE=1` (see `lib/media/asset-pool.ts`);
 * otherwise the browser IndexedDB pool remains the backend.
 */
import type { AssetMeta, AssetRef, BinaryBlob, StorageProvider } from '@openmaic/storage';
import { newAssetId } from '@openmaic/storage';

export type HttpAssetHeadersHook = () => HeadersInit | Promise<HeadersInit>;

export interface HttpAssetStoreOptions {
  /** Root URL before the contract's `/assets/...` paths. */
  baseUrl: string;
  /** Attaches authentication headers (learner key + dev token) to every call. */
  headers?: HttpAssetHeadersHook;
}

function normalizeHeaders(init: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (init === undefined) return normalized;
  if (Array.isArray(init)) {
    for (const [name, value] of init) normalized[name.toLowerCase()] = value;
  } else if (typeof (init as Headers).forEach === 'function') {
    (init as Headers).forEach((value, name) => normalized[name.toLowerCase()] = value);
  } else {
    for (const [name, value] of Object.entries(init)) normalized[name.toLowerCase()] = value;
  }
  return normalized;
}

export class HttpAssetStore implements StorageProvider {
  private readonly baseUrl: string;
  private readonly headersHook: HttpAssetHeadersHook | undefined;

  constructor(options: HttpAssetStoreOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.headersHook = options.headers;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return normalizeHeaders(await this.headersHook?.());
  }

  private assetUrl(ref: AssetRef): string {
    return `${this.baseUrl}/assets/${encodeURIComponent(ref)}`;
  }

  async put(data: BinaryBlob, meta: AssetMeta = {}): Promise<AssetRef> {
    const id = newAssetId();
    await this.write(id, data, meta);
    return id;
  }

  async replace(ref: AssetRef, data: BinaryBlob, meta?: AssetMeta): Promise<void> {
    await this.write(ref, data, meta);
  }

  async remove(ref: AssetRef): Promise<void> {
    const response = await fetch(this.assetUrl(ref), {
      method: 'DELETE',
      headers: await this.authHeaders(),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`HttpAssetStore: remove failed (HTTP ${response.status})`);
    }
  }

  async resolve(ref: AssetRef): Promise<string | null> {
    const response = await fetch(this.assetUrl(ref), { headers: await this.authHeaders() });
    if (!response.ok) return null;
    const mime = response.headers.get('content-type') ?? '';
    const bytes = await response.arrayBuffer();
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** No cached object URLs to revoke; present for pool-view compatibility. */
  release(_ref: AssetRef): Promise<void> {
    return Promise.resolve();
  }

  private async write(ref: AssetRef, data: BinaryBlob, meta?: AssetMeta): Promise<void> {
    const bytes = await data.arrayBuffer();
    const mime = meta?.contentType ?? data.type;
    const headers = await this.authHeaders();
    headers['content-type'] = mime || 'application/octet-stream';
    const hasMeta = meta !== undefined && Object.keys(meta).length > 0;
    if (hasMeta) {
      headers['x-asset-meta'] = btoa(
        unescape(encodeURIComponent(JSON.stringify(meta))),
      );
    }
    const response = await fetch(this.assetUrl(ref), {
      method: 'PUT',
      headers,
      body: bytes,
    });
    if (!response.ok) {
      throw new Error(`HttpAssetStore: write failed (HTTP ${response.status})`);
    }
  }
}