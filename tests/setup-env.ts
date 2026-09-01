/**
 * Load .env.local before tests so API keys are available.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { afterEach, vi } from 'vitest';

const envPath = resolve(__dirname, '..', '.env.local');
try {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // NEXT_PUBLIC_* vars are inlined into the client bundle at build time by
    // Next.js; they are meaningless (and behavior-changing) in the Node test
    // environment, so they are never loaded here.
    if (key.startsWith('NEXT_PUBLIC_')) continue;
    // Server-persistence configuration selects backend branches in the routes
    // under test; a developer's local .env.local (file-backed dir, dev token,
    // database URL) must not flip those routes into their local-only mode.
    if (key.startsWith('PERSISTENCE_') || key === 'DATABASE_URL') continue;
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env.local not found, skip
}

/**
 * Per-test hygiene, applied to every file that uses this config.
 *
 * Cross-file isolation is guaranteed by the pinned pool/isolate settings
 * above; this guard covers the intra-file failure modes that actually
 * occur in this suite: a test stubbing an env var without cleanup (the
 * next test in the file inherits it), mock call history accumulating
 * across tests, fake timers left installed after a test that took an
 * early exit, and DOM-storage residue in happy-dom files.
 *
 * Deliberately NOT done here:
 * - `vi.unstubAllGlobals()` — several suites install globals in
 *   `beforeAll` for the whole file (sessionStorage, IDBKeyRange, FileReader
 *   stubs); unstubbing per test would break them.
 * - `vi.restoreAllMocks()` — would tear down implementations installed
 *   once per file, not just call history.
 * - IndexedDB teardown — suites own their `IDBFactory` instances per test;
 *   no ambient factory cleanup is safe to assume.
 */
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
  // Some suites stub storage with partial mocks; only call a real .clear.
  if (typeof globalThis.localStorage?.clear === 'function') {
    globalThis.localStorage.clear();
  }
  if (typeof globalThis.sessionStorage?.clear === 'function') {
    globalThis.sessionStorage.clear();
  }
});
