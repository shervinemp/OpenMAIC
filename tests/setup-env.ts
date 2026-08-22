/**
 * Load .env.local before tests so API keys are available.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

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
