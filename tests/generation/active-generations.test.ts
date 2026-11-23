// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readActiveGenerationStageIds } from '@/lib/generation/active-generations';

describe('readActiveGenerationStageIds', () => {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else delete (navigator as unknown as Record<string, unknown>).locks;
  });

  it('reads held generation leases', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        query: async () => ({
          held: [
            { name: 'openmaic-generate:ddia' },
            { name: 'openmaic-generate:react' },
            { name: 'unrelated-lock' },
          ],
        }),
      },
    });
    expect([...(await readActiveGenerationStageIds())].sort()).toEqual(['ddia', 'react']);
  });

  it('includes a live intent while the lease query is still racing', async () => {
    window.localStorage.setItem(
      'openmaic:generation-intent:ddia',
      JSON.stringify({ intent: 'active', at: Date.now() }),
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { query: async () => ({ held: [] }) },
    });
    expect([...(await readActiveGenerationStageIds())]).toEqual(['ddia']);
  });

  it('ignores stopped intent and malformed records', async () => {
    window.localStorage.setItem(
      'openmaic:generation-intent:ddia',
      JSON.stringify({ intent: 'stopped', at: Date.now() }),
    );
    window.localStorage.setItem('openmaic:generation-intent:react', '{bad json');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { query: async () => ({ held: [] }) },
    });
    expect((await readActiveGenerationStageIds()).size).toBe(0);
  });

  it('falls back to intent when Web Locks are unavailable', async () => {
    window.localStorage.setItem(
      'openmaic:generation-intent:ddia',
      JSON.stringify({ intent: 'active', at: Date.now() }),
    );
    delete (navigator as unknown as Record<string, unknown>).locks;
    expect([...(await readActiveGenerationStageIds())]).toEqual(['ddia']);
  });
});
