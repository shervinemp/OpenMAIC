import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createStorageHttpHandler,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  type AssetIndirectByteEgress,
} from '@openmaic/storage/server';
import { JsonFileDocumentStore } from '@openmaic/storage/server/file-document-store';
import { JsonFileRuntimeStore } from '@openmaic/storage/server/file-runtime-store';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { resolveAssetCollectionGraceMs } from '@/lib/persistence/asset-collection-grace';
import { authenticatePersistenceRequest } from '@/lib/persistence/server-auth';
import {
  getServerPersistenceProvider,
  type PersistencePoolFactory,
} from '@/lib/persistence/server-provider';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';

export const runtime = 'nodejs';

const ROUTE_PREFIX = '/api/persistence';

interface PersistenceHandlerState {
  connectionString?: string;
  handlerPromise?: Promise<RequestListener>;
}

const HANDLER_STATE_KEY = Symbol.for('openmaic.persistence-route.handler');
const globalState = globalThis as typeof globalThis & {
  [key: symbol]: PersistenceHandlerState | undefined;
};
const handlerState = (globalState[HANDLER_STATE_KEY] ??= {});

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * Redirect byte egress opts asset reads into serving a short-lived signed URL,
 * when the byte layer can sign (S3 can; the PostgreSQL byte column cannot, and
 * falls back to direct bytes). Anything else, including unset and `direct`,
 * keeps the default byte-for-byte behavior. The tradeoff this opts into -- the
 * redirect target names the content hash -- is specified in the storage
 * package's asset HTTP contract.
 */
function configuredAssetByteEgress(value: string | undefined): 'redirect' | undefined {
  const raw = value?.trim().toLowerCase();
  if (raw === 'redirect') return 'redirect';
  if (raw === undefined || raw === '' || raw === 'direct') return undefined;
  console.warn(`ASSET_BYTE_EGRESS=${value} is not recognized; using direct byte egress`);
  return undefined;
}

/**
 * Redirect egress and the collection grace must agree: a signed URL that
 * outlives its object turns a valid read into an object-store error. The
 * handler enforces that invariant itself, on the grace passed here, and this
 * grace is resolved by the collector's own parser so both components run on one
 * number.
 *
 * A grace too short for the default lifetime degrades to direct egress with a
 * loud warning rather than failing initialization: the asset backend is
 * optional, and its misconfiguration must never take document and runtime
 * traffic down with it.
 */
function indirectEgressWithinGrace(
  egress: 'redirect' | undefined,
): AssetIndirectByteEgress | undefined {
  if (egress !== 'redirect') return undefined;
  const collectionGraceMs = resolveAssetCollectionGraceMs();
  if (collectionGraceMs < DEFAULT_SIGNED_URL_TTL_SECONDS * 1000 * 10) {
    console.warn(
      `ASSET_BYTE_EGRESS=redirect requires ASSET_COLLECTION_GRACE_MS to be at least ten times ` +
        `the signed URL lifetime (${DEFAULT_SIGNED_URL_TTL_SECONDS}s); got ${collectionGraceMs}ms. ` +
        `Falling back to direct byte egress.`,
    );
    return undefined;
  }
  return { mode: 'redirect', collectionGraceMs };
}

async function createPersistenceHandler(
  connectionString: string,
  poolFactory?: PersistencePoolFactory,
): Promise<RequestListener> {
  const { runtimeStore, documentStore, assetStore } = await getServerPersistenceProvider(
    connectionString,
    poolFactory,
  );
  // The asset contract requires a server-derived principal; this development
  // authenticator instead takes the partition key from a client-supplied header.
  // Cross-principal isolation is therefore not in force: asset bytes are as
  // reachable as documents and runtime records under this authenticator. Before
  // asset routes carry anything that matters, production must replace
  // authenticatePersistenceRequest with real session verification. See
  // lib/persistence/server-auth.ts for the token's limits.
  // Reclamation is not scheduled from here, and must not be: a route module
  // has no once-per-process guarantee and no shutdown hook. AssetCollector
  // runs from instrumentation.ts instead, over the byte store this same
  // lib/persistence/asset-byte-store selection produces, so the collector
  // always deletes through the layer the request path wrote through.
  const byteEgress = indirectEgressWithinGrace(
    configuredAssetByteEgress(process.env.ASSET_BYTE_EGRESS),
  );
  return createStorageHttpHandler(runtimeStore, documentStore, {
    authenticate: authenticatePersistenceRequest,
    authorizeMerge: async () => false,
    authorizeAdmin: async () => false,
    authorizeDocuments: async () => true,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    assetStore,
    ...(byteEgress === undefined ? {} : { byteEgress }),
  });
}

/** File-backed (no database) single-user backend for localhost self-hosting. */
function createFilePersistenceHandler(dir: string): RequestListener {
  const runtimeStore = new JsonFileRuntimeStore({ dir });
  const documentStore = new JsonFileDocumentStore({
    dir,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
  return createStorageHttpHandler(runtimeStore, documentStore, {
    authenticate: authenticatePersistenceRequest,
    authorizeMerge: async () => true,
    authorizeAdmin: async () => true,
    authorizeDocuments: async () => true,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

// --- Media assets (file-backed, local only) -------------------------------

const MAX_ASSET_BYTES = 256 * 1024 * 1024;

function assetAuthorized(request: Request): boolean {
  const token = process.env.PERSISTENCE_DEV_TOKEN;
  const authorization = request.headers.get('authorization');
  if (!token || !authorization || authorization !== `Bearer ${token}`) return false;
  return true;
}

function assetRefOf(pathname: string): string | null {
  const rest = pathname.slice('/assets/'.length);
  if (rest === '' || rest === '/' || rest === '.' || rest === '..') return null;
  try {
    const ref = decodeURIComponent(rest);
    if (ref === '' || ref === '.' || ref === '..' || ref.includes('/')) return null;
    return ref;
  } catch {
    return null;
  }
}

async function readBodyWithCap(request: Request): Promise<Uint8Array | null> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_ASSET_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_ASSET_BYTES) return null;
  return bytes;
}

async function handleAssetsRequest(
  request: Request,
  dir: string,
  strippedPathname: string,
): Promise<Response> {
  if (!assetAuthorized(request)) {
    return jsonError(401, 'UNAUTHENTICATED', 'server persistence requires authentication');
  }
  const ref = assetRefOf(strippedPathname);
  if (ref === null) return jsonError(404, 'ROUTE_NOT_FOUND', 'route not found');
  const encoded = encodeURIComponent(ref);
  const assetDir = join(dir, 'assets');
  const metaDir = join(assetDir, '.meta');
  const assetPath = join(assetDir, encoded);
  const metaPath = join(metaDir, `${encoded}.json`);

  if (request.method === 'PUT') {
    const bytes = await readBodyWithCap(request);
    if (bytes === null) {
      return jsonError(413, 'PAYLOAD_TOO_LARGE', 'asset exceeds the 256 MiB limit');
    }
    const mime = request.headers.get('content-type') ?? '';
    const metaHeader = request.headers.get('x-asset-meta');
    let meta: Record<string, unknown> | undefined;
    if (metaHeader) {
      try {
        const parsed = JSON.parse(
          decodeURIComponent(escape(atob(metaHeader))),
        ) as Record<string, unknown>;
        if (typeof parsed === 'object' && parsed !== null) meta = parsed;
      } catch {
        return jsonError(400, 'INVALID_META', 'x-asset-meta must be base64 JSON');
      }
    }
    try {
      await mkdir(metaDir, { recursive: true });
      await writeFile(assetPath, bytes);
      await writeFile(
        metaPath,
        JSON.stringify({ mime, meta: meta ?? {}, size: bytes.byteLength }),
        'utf8',
      );
    } catch (error) {
      console.error('Persistence asset write failed', error);
      return jsonError(500, 'ASSET_WRITE_FAILED', 'asset write failed');
    }
    return new Response(null, { status: 204 });
  }

  if (request.method === 'GET') {
    try {
      const bytes = await readFile(assetPath);
      const stored = JSON.parse(await readFile(metaPath, 'utf8')) as {
        mime?: unknown;
      };
      const mime = typeof stored?.mime === 'string' ? stored.mime : 'application/octet-stream';
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': mime },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return jsonError(404, 'ASSET_NOT_FOUND', 'asset not found');
      }
      return jsonError(500, 'ASSET_READ_FAILED', 'asset read failed');
    }
  }

  if (request.method === 'DELETE') {
    await rm(assetPath, { force: true }).catch(() => {});
    await rm(metaPath, { force: true }).catch(() => {});
    return new Response(null, { status: 204 });
  }

  return jsonError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
}

function getPersistenceHandler(
  connectionString: string,
  poolFactory?: PersistencePoolFactory,
): Promise<RequestListener> {
  if (handlerState.handlerPromise && handlerState.connectionString === connectionString) {
    return handlerState.handlerPromise;
  }

  handlerState.connectionString = connectionString;
  const initialization = createPersistenceHandler(connectionString, poolFactory).catch((error) => {
    // Do not poison the singleton with a rejected promise. createPersistenceHandler
    // has already closed its failed pool, and the next request gets a clean retry.
    if (handlerState.handlerPromise === initialization) {
      handlerState.handlerPromise = undefined;
      handlerState.connectionString = undefined;
    }
    throw error;
  });
  handlerState.handlerPromise = initialization;
  return initialization;
}

function nodeRequest(request: Request): IncomingMessage {
  const url = new URL(request.url);
  const pathname = url.pathname.startsWith(ROUTE_PREFIX)
    ? url.pathname.slice(ROUTE_PREFIX.length) || '/'
    : url.pathname;
  const body = request.body
    ? Readable.fromWeb(
        request.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
      )
    : Readable.from([]);
  return Object.assign(body, {
    method: request.method,
    url: `${pathname}${url.search}`,
    headers: Object.fromEntries(request.headers.entries()),
  }) as IncomingMessage;
}

function setHeaders(target: Headers, source: Record<string, string | number | string[]>): void {
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const item of value) target.append(name, item);
    } else {
      target.set(name, String(value));
    }
  }
}

function runNodeHandler(handler: RequestListener, request: Request): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let status = 200;
    const headers = new Headers();
    let headersSent = false;

    const response = {
      get headersSent() {
        return headersSent;
      },
      writeHead(
        statusCode: number,
        statusMessageOrHeaders?: string | Record<string, string | number | string[]>,
        outgoingHeaders?: Record<string, string | number | string[]>,
      ) {
        status = statusCode;
        headersSent = true;
        const values =
          typeof statusMessageOrHeaders === 'string' ? outgoingHeaders : statusMessageOrHeaders;
        if (values) setHeaders(headers, values);
        return this;
      },
      end(chunk?: string | Uint8Array) {
        headersSent = true;
        resolve(
          new Response(
            chunk === undefined
              ? undefined
              : typeof chunk === 'string'
                ? chunk
                : Buffer.from(chunk).toString(),
            {
              status,
              headers,
            },
          ),
        );
        return this;
      },
      destroy(error?: Error) {
        reject(error ?? new Error('Persistence HTTP handler destroyed the response'));
        return this;
      },
    } as unknown as ServerResponse;

    try {
      handler(nodeRequest(request), response);
    } catch (error) {
      reject(error);
    }
  });
}

interface PersistenceRequestDeps {
  poolFactory?: PersistencePoolFactory;
}

export async function handlePersistenceRequest(
  request: Request,
  deps: PersistenceRequestDeps = {},
): Promise<Response> {
  // Local single-user backend: PERSISTENCE_DIR selects zero-dependency JSON
  // files on disk, so no DATABASE_URL / Postgres is required for localhost
  // self-hosting (lessons live on disk, not in a browser origin).
  const fileDir = process.env.PERSISTENCE_DIR;
  if (fileDir) {
    if (!process.env.PERSISTENCE_DEV_TOKEN) {
      return jsonError(
        503,
        'PERSISTENCE_DEV_TOKEN_MISSING',
        'server persistence requires PERSISTENCE_DEV_TOKEN (development auth only)',
      );
    }
    const pathname = new URL(request.url).pathname.replace(/^\/api\/persistence/, '') || '/';
    if (pathname === '/assets' || pathname.startsWith('/assets/')) {
      return handleAssetsRequest(request, fileDir, pathname);
    }
    return runNodeHandler(createFilePersistenceHandler(fileDir), request);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return jsonError(404, 'PERSISTENCE_NOT_CONFIGURED', 'server persistence not configured');
  }
  if (!process.env.PERSISTENCE_DEV_TOKEN) {
    return jsonError(
      503,
      'PERSISTENCE_DEV_TOKEN_MISSING',
      'server persistence requires PERSISTENCE_DEV_TOKEN (development auth only)',
    );
  }

  try {
    return await runNodeHandler(
      await getPersistenceHandler(connectionString, deps.poolFactory),
      request,
    );
  } catch (error) {
    console.error('Embedded persistence route initialization failed', error);
    return jsonError(500, 'PERSISTENCE_INIT_FAILED', 'server persistence initialization failed');
  }
}

export const GET = (request: Request) => handlePersistenceRequest(request);
export const POST = (request: Request) => handlePersistenceRequest(request);
export const PUT = (request: Request) => handlePersistenceRequest(request);
export const PATCH = (request: Request) => handlePersistenceRequest(request);
export const DELETE = (request: Request) => handlePersistenceRequest(request);
