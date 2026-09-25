import { availableParallelism } from 'os';
import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
    // Isolation is load-bearing, not an implementation detail: several suites
    // stub env vars, fake timers, and browser globals. These are the vitest
    // defaults, pinned explicitly so a future default change (or a speed
    // optimization) cannot silently turn per-file leaks into cross-file
    // chaos.
    pool: 'forks',
    isolate: true,
    fileParallelism: true,
    // Half the cores, and never more than 8: this suite contains
    // process-spawning tests (programmatic ESLint, route cold-imports) with 5s
    // default timeouts. Oversubscribed forks make those tests flake on
    // timeouts even though each passes in isolation - measured on a 24-thread
    // dev box (16 forks: 952s cumulative module imports, 46 spurious failures;
    // 8 forks: 190s, zero failures). A bare '50%' is 16 forks on a 32-thread
    // box, so the cap is absolute. Half also keeps CI's 4-core runner inside
    // the envelope its own sequential-suite comment describes.
    maxWorkers: Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2))),
  },
});
