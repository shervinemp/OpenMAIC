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
    // Half the cores, never more: this suite contains process-spawning tests
    // (programmatic ESLint, route cold-imports) with 5s default timeouts.
    // Above ~half the cores the forks oversubscribe the CPU and those tests
    // flake on timeouts even though each passes in isolation - measured on a
    // 24-thread dev box (16 forks: 952s cumulative module imports, 46 spurious
    // failures; 8 forks: 190s, zero failures). 50% also keeps CI's 4-core
    // runner inside the envelope its own sequential-suite comment describes.
    maxWorkers: '50%',
  },
});
