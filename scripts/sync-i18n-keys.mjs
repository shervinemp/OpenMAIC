#!/usr/bin/env node
/**
 * Sync parity: copy any leaf key missing from a locale out of en-US.json so
 * every key resolves. The fallback is the ENGLISH string, verbatim (contents
 * are left for human translation — this script owns presence, not wording),
 * placed at the same tree position so the checker sees an aligned forest.
 * Extra (stale) keys a locale carries are reported but never removed here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'lib', 'i18n', 'locales');
const SOURCE = 'en-US.json';

const flatten = (obj, prefix = '', acc = {}) => {
  for (const [key, value] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, path, acc);
    } else {
      acc[path] = value;
    }
  }
  return acc;
};

const deepSet = (obj, path, value) => {
  const parts = path.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts.at(-1)] = value;
};

const countLeaves = (obj) =>
  Object.entries(obj ?? {}).reduce(
    (n, [, v]) =>
      n + (v !== null && typeof v === 'object' && !Array.isArray(v) ? countLeaves(v) : 1),
    0,
  );

const source = JSON.parse(readFileSync(join(dir, SOURCE), 'utf8'));
const sourceLeaves = flatten(source);

import { readdirSync } from 'node:fs';
const locales = readdirSync(dir).filter((name) => name.endsWith('.json') && name !== SOURCE);

for (const name of locales) {
  const path = join(dir, name);
  const target = JSON.parse(readFileSync(path, 'utf8'));
  const targetLeaves = flatten(target);
  const missing = Object.keys(sourceLeaves).filter((key) => !(key in targetLeaves));
  const extra = Object.keys(targetLeaves).filter((key) => !(key in sourceLeaves));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`${name}: aligned`);
    continue;
  }
  for (const key of missing) {
    deepSet(target, key, sourceLeaves[key]);
  }
  writeFileSync(path, `${JSON.stringify(target, null, 2)}\n`, 'utf8');
  console.log(
    `${name}: filled ${missing.length} missing (from ${SOURCE})${extra.length ? `; ${extra.length} extra left as-is` : ''} — leaves ${countLeaves(target)}`,
  );
}
