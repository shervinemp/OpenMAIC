/**
 * Copy the browser runtime for activity code labs from the installed `pyodide`
 * package into `public/vendor/pyodide`.
 *
 * Vendoring is deliberate: a course must keep running offline, and loading the
 * interpreter from a CDN would make every lab depend on a third-party origin.
 * The output directory is gitignored (it is a build artifact, ~13 MB) and is
 * regenerated on install/build.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', 'pyodide');
const target = join(root, 'public', 'vendor', 'pyodide');

/** Only the files the browser runtime loads. Maps and docs are not shipped. */
const FILES = [
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
];

function fail(message) {
  console.error(`[sync-pyodide] ${message}`);
  process.exit(1);
}

if (!existsSync(source)) {
  fail(`pyodide is not installed at ${source}. Run \`pnpm install\` first.`);
}

for (const file of FILES) {
  if (!existsSync(join(source, file))) {
    fail(`missing ${file} in ${source}; the installed pyodide package is incomplete.`);
  }
}

mkdirSync(target, { recursive: true });
for (const file of FILES) {
  cpSync(join(source, file), join(target, file));
}

/**
 * A stale file with the same name would shadow the freshly copied runtime, so
 * report anything extra instead of leaving it silently in place.
 */
const extras = readdirSync(target).filter((name) => !FILES.includes(name));
if (extras.length > 0) {
  console.warn(`[sync-pyodide] removing unexpected files: ${extras.join(', ')}`);
  for (const name of extras) {
    const path = join(target, name);
    if (statSync(path).isFile()) rmSync(path);
  }
}

console.log(`[sync-pyodide] wrote ${FILES.length} runtime files to public/vendor/pyodide`);
