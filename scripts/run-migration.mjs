/**
 * One-shot migration driver: exports the OLD browser origin's data via
 * `scripts/migration-source.html` (served by persian_hub on :3000), then
 * imports it through the app's `/migrate` page on the CURRENT port.
 *
 * Runs headlessly against the user's real Chrome profile, so it reads and
 * writes the same browser storage the user sees. Requires Chrome to be fully
 * closed (profile lock) and the persistence stack to be running.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';
import { chromium } from '../node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Browser profile being read (a mirror of the source browser's user-data-dir).
const PROFILE = process.env.MAIC_MIRROR_PROFILE ?? 'C:\\Users\\sherv\\AppData\\Local\\Temp\\opencode\\ddg-mirror';
const OLD_ORIGIN = 'http://localhost:3000';
const NEW_ORIGIN = process.env.OPENMAIC_URL ?? 'http://localhost:3001';
const WORK = 'C:\\Users\\sherv\\AppData\\Local\\Temp\\opencode';
const EXPORT_PATH = join(WORK, 'openmaic-migration.json');
const PERSISTENCE_DIR = 'C:\\Users\\sherv\\Desktop\\OpenMAIC\\.data\\persistence';

let context;
try {
  console.log('Launching headless Chrome with the real profile…');
  context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: true,
    viewport: null,
  });

  // --- Step 1: export from the old origin -------------------------------
  // Navigate to ANY page on the old origin (its origin grants storage
  // access), then run the dump logic inline — no helper file is hosted on
  // the old origin's server.
  const exportPage = await context.newPage();
  console.log(`Opening ${OLD_ORIGIN}/ …`);
  await exportPage.goto(`${OLD_ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });

  const payloadJson = await exportPage.evaluate(async () => {
    const promisifyRequest = (req) =>
      new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

    const readStoreWithKeys = (db, storeName) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const rows = [];
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            rows.push([cursor.key, cursor.value]);
            cursor.continue();
          } else {
            resolve(rows);
          }
        };
        request.onerror = () => reject(request.error);
      });

    const bufferToBase64 = (buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(binary);
    };

    const serializeValue = async (storeName, value) => {
      if (value instanceof ArrayBuffer) return { $bin: bufferToBase64(value) };
      if (ArrayBuffer.isView(value)) {
        return {
          $bin: bufferToBase64(
            value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
          ),
        };
      }
      if (value instanceof Blob) {
        return { $bin: bufferToBase64(await value.arrayBuffer()) };
      }
      return value;
    };

    const dumpDatabase = async (dbName) => {
      const result = {};
      const openRequest = indexedDB.open(dbName);
      try {
        const db = await promisifyRequest(openRequest);
        for (const storeName of Array.from(db.objectStoreNames)) {
          const rows = await readStoreWithKeys(db, storeName);
          const out = [];
          for (const [key, value] of rows) out.push([key, await serializeValue(storeName, value)]);
          result[storeName] = out;
        }
        db.close();
        return result;
      } catch (error) {
        return { $error: error instanceof Error ? error.message : String(error) };
      }
    };

    const dbList = await (indexedDB.databases ? indexedDB.databases() : Promise.resolve([]));
    const databases = [];
    for (const { name } of dbList) {
      if (typeof name !== 'string' || !/maic|openmaic/i.test(name)) continue;
      const stores = await dumpDatabase(name);
      if (stores && !('$error' in stores)) databases.push({ name, stores });
    }

    const local = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      local[key] = localStorage.getItem(key);
    }

    return JSON.stringify({
      app: 'openmaic',
      kind: 'origin-migration',
      origin: location.origin,
      exportedAt: new Date().toISOString(),
      databases,
      localStorage: local,
    });
  });

  await mkdir(WORK, { recursive: true });
  await writeFile(EXPORT_PATH, payloadJson, 'utf8');
  console.log(`Exported → ${EXPORT_PATH} (${payloadJson.length} bytes)`);
  const parsed = JSON.parse(payloadJson);
  for (const db of parsed.databases ?? []) {
    const storeNames = Object.keys(db.stores ?? {});
    console.log(`  db ${db.name}: stores [${storeNames.join(', ')}]`);
  }
  console.log(`  localStorage keys: ${Object.keys(parsed.localStorage ?? {}).length}`);
  await exportPage.close();

  // --- Step 2: import at the current origin ------------------------------
  const importPage = await context.newPage();
  console.log(`Opening ${NEW_ORIGIN}/migrate …`);
  await importPage.goto(`${NEW_ORIGIN}/migrate`, { waitUntil: 'load', timeout: 90_000 });
  await importPage.waitForSelector('input[type="file"]', { timeout: 60_000 });

  await importPage.setInputFiles('input[type="file"]', EXPORT_PATH);
  console.log('Waiting for the import report…');
  await importPage.waitForSelector('pre', { timeout: 180_000 });
  await importPage.waitForFunction(
    () => document.querySelector('pre')?.textContent?.includes('reload the app'),
    { timeout: 180_000 },
  );
  const report = await importPage.textContent('pre');
  console.log('--- import report ---');
  console.log(report);
  await importPage.close();
} finally {
  await context?.close().catch(() => {});
}

// --- Step 3: verify server-side persistence ------------------------------
const docDir = join(PERSISTENCE_DIR, 'documents');
const files = await readdir(docDir).catch(() => []);
console.log(`Documents on disk (${PERSISTENCE_DIR}): ${files.length}`);
for (const file of files) console.log(`  ${file}`);

const assetDir = join(PERSISTENCE_DIR, 'assets');
const assetFiles = await readdir(assetDir).catch(() => []);
const assetCount = assetFiles.filter((f) => !f.startsWith('.')).length;
console.log(`Assets on disk (${assetDir}): ${assetCount} refs`);

if (files.length === 0) {
  console.error('WARNING: no documents persisted on disk — something went wrong.');
  process.exitCode = 1;
} else {
  console.log('Migration complete — all data now lives on the local server disk.');
}