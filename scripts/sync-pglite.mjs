/**
 * Copy the browser SQL engine for activity SQL labs from the installed
 * `@electric-sql/pglite` package into `public/vendor/pglite`.
 *
 * PGlite resolves its wasm and filesystem image relative to its own module
 * URL, so the whole loader (entry + chunks) has to sit beside `pglite.wasm`
 * and `pglite.data` on the app's origin. Vendoring keeps a course runnable
 * offline and avoids a third-party CDN at lab time.
 *
 * The output directory is gitignored (it is a build artifact, ~14 MB) and is
 * regenerated on install/build.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', '@electric-sql', 'pglite', 'dist');
const target = join(root, 'public', 'vendor', 'pglite');

/** The loader entry, its versioned chunks, and the two large runtime assets. */
const FIXED_FILES = ['index.js', 'pglite.wasm', 'pglite.data'];

function fail(message) {
  console.error(`[sync-pglite] ${message}`);
  process.exit(1);
}

if (!existsSync(source)) {
  fail(`@electric-sql/pglite is not installed at ${source}. Run \`pnpm install\` first.`);
}

const chunkFiles = readdirSync(source).filter((name) => /^chunk-[\w-]+\.js$/.test(name));
if (chunkFiles.length === 0) {
  fail(`no loader chunks found in ${source}; the installed pglite package is incomplete.`);
}

const files = [...FIXED_FILES, ...chunkFiles];
for (const file of files) {
  if (!existsSync(join(source, file))) {
    fail(`missing ${file} in ${source}; the installed pglite package is incomplete.`);
  }
}

mkdirSync(target, { recursive: true });
for (const file of files) {
  cpSync(join(source, file), join(target, file));
}

/**
 * A stale chunk from an older PGlite version would still be reachable by URL
 * and could shadow the current loader, so report and remove extras.
 */
const extras = readdirSync(target).filter((name) => !files.includes(name));
if (extras.length > 0) {
  console.warn(`[sync-pglite] removing unexpected files: ${extras.join(', ')}`);
  for (const name of extras) {
    const path = join(target, name);
    if (statSync(path).isFile()) rmSync(path);
  }
}

console.log(`[sync-pglite] wrote ${files.length} runtime files to public/vendor/pglite`);
