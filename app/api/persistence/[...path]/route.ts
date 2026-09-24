import { randomUUID } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createStorageHttpHandler,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  type AssetIndirectByteEgress,
} from '@openmaic/storage/server';
import { JsonFileDocumentStore } from '@openmaic/storage/server/file-document-store';
import { JsonFileRuntimeStore } from '@openmaic/storage/server/file-runtime-store';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createLogger } from '@/lib/logger';
import { getCourseGitScheduler } from '@/lib/persistence/git-course-sync';
import { GitSyncDocumentStore } from '@/lib/persistence/git-sync-document-store';
import { resolveAssetCollectionGraceMs } from '@/lib/persistence/asset-collection-grace';
import {
  decideDocumentAccess,
  parseDocumentAction,
  type DocumentAccess,
} from '@/lib/persistence/document-access';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import {
  authenticatePersistenceRequest,
  SHARED_ASSET_PRINCIPAL,
} from '@/lib/persistence/server-auth';
import {
  getServerPersistenceProvider,
  type PersistencePoolFactory,
} from '@/lib/persistence/server-provider';
import { readStageMeta } from '@/lib/persistence/stage-meta';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

const ROUTE_PREFIX = '/api/persistence';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const log = createLogger('Persistence');

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * ASSET_BYTE_EGRESS: set to `redirect` to answer asset byte GETs with a 302 to
 * a short-lived signed URL, when the byte layer can sign (S3 can; the
 * PostgreSQL byte column cannot, and falls back to direct bytes). Anything
 * else, including unset and `direct`, keeps the default byte-for-byte
 * behavior. The tradeoff this opts into -- the redirect target names the
 * content hash -- is specified in the storage package's asset HTTP contract.
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
  ownerId: string,
  access: DocumentAccess,
  poolFactory?: PersistencePoolFactory,
): Promise<RequestListener> {
  const { pool, runtimeStore, assetStore } = await getServerPersistenceProvider(
    connectionString,
    poolFactory,
  );
  const documentStore = createOwnerBoundDocumentStore({
    pool,
    ownerId,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
  // The asset posture, precisely.
  //
  // Reading an asset and allocating one are open to any caller this deployment
  // lets in, exactly as reading a document and creating one already are: assets
  // live in a single shared partition by design (see the SHARED_ASSET_PRINCIPAL
  // comment in lib/persistence/server-auth.ts), so there is nothing per-caller
  // for the development authenticator to decide about them, and routing them
  // through it made every asset request fail in a production build that had not
  // opted into that authenticator — the build this project's own
  // server-persistence recipe produces.
  //
  // Replacing and deleting are refused outright — to everyone, authenticated or
  // not. Those operations scope by principal key alone, and every caller
  // resolves to the same shared key, so authentication decides nothing here:
  // any signed-in visitor who learned an id, and a document read hands out
  // every id its slides name, could overwrite or destroy another author's
  // media. There is no per-asset ownership to check against yet, and since this
  // application began storing generated media the registry is the only copy a
  // course has, so the answer is no mutations at all. Nothing in the app
  // performs an asset PUT or DELETE, and none needs to: the server owns the
  // entry lifecycle. A document write records what that document claims in the
  // reference table and commits the allocations it names; deleting the document
  // withdraws those claims; the collector's entry pass releases an entry whose
  // last claim left longer ago than the grace period, and an allocation no
  // document ever claimed once its pending TTL expires. The bytes follow after
  // their own grace.
  //
  // What this is NOT: a per-caller access control. The deployment-level fence
  // is the access code. Allocation is bounded by the asset store's per-principal
  // quota, which with one shared principal is a deployment-wide cap.
  //
  // Runtime requests still take their partition key from a client-supplied
  // header, because a runtime session genuinely is per-learner state. Before
  // runtime routes carry production data, their authenticator must be replaced
  // with real session verification.
  // Reclamation is not scheduled from here, and must not be: a route module
  // has no once-per-process guarantee and no shutdown hook. AssetCollector
  // runs from instrumentation.ts instead, over the byte store this same
  // lib/persistence/asset-byte-store selection produces, so the collector
  // always deletes through the layer the request path wrote through. The
  // document store this handler mounts is the other half of that mechanism:
  // createOwnerBoundDocumentStore builds it with reference tracking on, which
  // is what gives the entry pass something to read.
  const byteEgress = indirectEgressWithinGrace(
    configuredAssetByteEgress(process.env.ASSET_BYTE_EGRESS),
  );
  return createStorageHttpHandler(runtimeStore, documentStore, {
    authenticate: async (request) => {
      if (request.url?.startsWith('/documents')) return { learnerKey: ownerId };
      if (request.url?.startsWith('/assets')) {
        return { key: SHARED_ASSET_PRINCIPAL, learnerKey: ownerId };
      }
      return authenticatePersistenceRequest(request);
    },
    authorizeAssets: async (_principal, request) => {
      const method = (request.method ?? 'GET').toUpperCase();
      // Reads and allocations for everyone; mutations for nobody, because the
      // principal they would be scoped to is shared and therefore proves
      // nothing about who is asking.
      return method !== 'PUT' && method !== 'DELETE';
    },
    authorizeMerge: async () => false,
    authorizeAdmin: async () => false,
    authorizeDocuments: async () => access === 'allow',
    validateScene: validateAppScene,
    validateStage: validateAppStage,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    assetStore,
    ...(byteEgress === undefined ? {} : { byteEgress }),
  });
}

function routeRelativePath(request: Request): string {
  const pathname = new URL(request.url).pathname;
  return pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) || '/' : pathname;
}

/** File-backed (no database) single-user backend for localhost self-hosting. */
function createFilePersistenceHandler(dir: string): RequestListener {
  const runtimeStore = new JsonFileRuntimeStore({ dir });
  const documentStore = new JsonFileDocumentStore({
    dir,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
  // Optional per-course git versioning: when a course is bound to a repo
  // (via /api/course-git), every mutating write schedules a debounced commit.
  // The decorator never fails a write — sync is best-effort by design.
  const scheduler = getCourseGitScheduler(dir);
  const wrapped = new GitSyncDocumentStore(documentStore, scheduler);
  return createStorageHttpHandler(runtimeStore, wrapped, {
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

  // HEAD = existence probe without the payload: voice-status re-checks and
  // migration sweeps cost a header round-trip, not a full narration download.
  if (request.method === 'HEAD') {
    const info = (await stat(assetPath).catch(() => null))?.isFile();
    return new Response(null, {
      status: info ? 200 : 404,
      headers: { allow: 'GET, PUT, HEAD, DELETE' },
    });
  }

  if (request.method === 'GET') {
    try {
      const bytes = await readFile(assetPath);
      // The sidecar only carries the MIME type: bytes without one (a copy
      // whose meta write failed, a manually restored file) are still the
      // asset HEAD reports as present — serve them as octet-stream instead
      // of a 404 that contradicts the existence probe.
      const stored = (await readFile(metaPath, 'utf8')
        .then((raw) => JSON.parse(raw) as { mime?: unknown })
        .catch(() => null)) ?? { mime: undefined };
      const mime =
        typeof stored.mime === 'string' && stored.mime ? stored.mime : 'application/octet-stream';
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

type ResponseCallback = () => void;

function responseEncoding(encodingOrCallback?: BufferEncoding | ResponseCallback): BufferEncoding {
  const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8';
  if (!Buffer.isEncoding(encoding)) {
    // Let Buffer produce Node's ERR_UNKNOWN_ENCODING TypeError.
    Buffer.from('', encoding);
  }
  return encoding;
}

function responseCallback(
  encodingOrCallback?: BufferEncoding | ResponseCallback,
  callback?: ResponseCallback,
): ResponseCallback | undefined {
  return typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
}

function suppressesResponseBody(request: Request, status: number): boolean {
  return request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
}

function runNodeHandler(handler: RequestListener, request: Request): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let status = 200;
    const headers = new Headers();
    let headersSent = false;
    // Buffered as bytes rather than as a string. A handler may end with a
    // `Uint8Array`, which `ServerResponse.end` accepts and which is not
    // necessarily valid UTF-8; decoding it would replace every unpaired byte
    // with U+FFFD and silently corrupt the response.
    const body: Buffer[] = [];

    const appendChunk = (chunk: string | Uint8Array, encoding: BufferEncoding) => {
      body.push(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk));
    };

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
      write(
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ResponseCallback,
        callback?: ResponseCallback,
      ) {
        // `write` is part of the `ServerResponse` surface this object claims to
        // implement. Omitting it made any chunked handler a runtime TypeError
        // that the `as unknown as ServerResponse` cast hid from the compiler.
        headersSent = true;
        appendChunk(chunk, responseEncoding(encodingOrCallback));
        const done = responseCallback(encodingOrCallback, callback);
        if (done) process.nextTick(done);
        return true;
      },
      end(
        chunkOrCallback?: string | Uint8Array | ResponseCallback,
        encodingOrCallback?: BufferEncoding | ResponseCallback,
        callback?: ResponseCallback,
      ) {
        headersSent = true;
        const chunk = typeof chunkOrCallback === 'function' ? undefined : chunkOrCallback;
        const done =
          typeof chunkOrCallback === 'function'
            ? chunkOrCallback
            : responseCallback(encodingOrCallback, callback);
        if (chunk !== undefined) appendChunk(chunk, responseEncoding(encodingOrCallback));
        resolve(
          new Response(
            suppressesResponseBody(request, status) || body.length === 0
              ? undefined
              : Buffer.concat(body),
            {
              status,
              headers,
            },
          ),
        );
        if (done) process.nextTick(done);
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

function persistenceRequestId(request: Request): string {
  const upstream = request.headers.get('x-request-id')?.trim();
  return upstream && REQUEST_ID_PATTERN.test(upstream) ? upstream : randomUUID();
}

async function responseErrorCode(response: Response): Promise<string> {
  if (!response.headers.get('content-type')?.includes('application/json')) return '-';
  const payload = (await response
    .clone()
    .json()
    .catch(() => undefined)) as { error?: { code?: unknown } } | undefined;
  return typeof payload?.error?.code === 'string' ? payload.error.code : '-';
}

export async function handlePersistenceRequest(
  request: Request,
  deps: PersistenceRequestDeps = {},
): Promise<Response> {
  const requestId = persistenceRequestId(request);
  const response = await handlePersistenceRequestInner(request, deps);
  if (response.status >= 500) {
    const path = new URL(request.url).pathname;
    const code = await responseErrorCode(response);
    log.error(`${request.method} ${path} -> ${response.status} ${code} (requestId=${requestId})`);
  }
  response.headers.set('x-request-id', requestId);
  return response;
}

async function handlePersistenceRequestInner(
  request: Request,
  deps: PersistenceRequestDeps,
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

  return withRequestOwnerId(request, async (ownerId, responseHeaders) => {
    try {
      const path = routeRelativePath(request);
      const action = parseDocumentAction(request.method, path);
      let access: DocumentAccess = 'allow';
      if (path === '/documents' || path.startsWith('/documents/')) {
        const { pool } = await getServerPersistenceProvider(connectionString, deps.poolFactory);
        const queryable = pool;
        access = await decideDocumentAccess(
          action,
          ownerId,
          (stageId) => readStageMeta(queryable, stageId),
          (stageId) =>
            pool
              .query('SELECT 1 FROM document_stages WHERE id = $1', [stageId])
              .then((result) => result.rows.length > 0),
          (stageId) => readStageMeta(queryable, stageId),
        );
      }

      const response =
        access === 'not-found'
          ? jsonError(404, 'DOCUMENT_NOT_FOUND', '@openmaic/storage: document not found')
          : await runNodeHandler(
              await createPersistenceHandler(connectionString, ownerId, access, deps.poolFactory),
              request,
            );
      for (const [name, value] of responseHeaders.entries()) response.headers.append(name, value);
      return response;
    } catch (error) {
      console.error('Embedded persistence route initialization failed', error);
      const response = jsonError(
        500,
        'PERSISTENCE_INIT_FAILED',
        'server persistence initialization failed',
      );
      for (const [name, value] of responseHeaders.entries()) response.headers.append(name, value);
      return response;
    }
  });
}

export const GET = (request: Request) => handlePersistenceRequest(request);
export const POST = (request: Request) => handlePersistenceRequest(request);
export const PUT = (request: Request) => handlePersistenceRequest(request);
export const PATCH = (request: Request) => handlePersistenceRequest(request);
export const DELETE = (request: Request) => handlePersistenceRequest(request);
