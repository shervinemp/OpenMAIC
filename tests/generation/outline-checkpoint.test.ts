import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const kvGet = vi.hoisted(() => vi.fn());

vi.mock('@openmaic/storage', () => ({
  BrowserKVStore: class {
    get = kvGet;
    async set(): Promise<void> {}
    async remove(): Promise<void> {}
  },
}));

import { adoptCheckpointSessionId } from '@/lib/generation/outline-checkpoint';

describe('outline checkpoint adoption on retry', () => {
  beforeEach(() => {
    kvGet.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('adopts the checkpoint sessionId when the requirement matches', async () => {
    kvGet.mockResolvedValue({
      sessionId: 'old-session',
      syllabus: { units: [] },
      outlines: [{ id: 'o1' }],
      completedUnitCount: 2,
      requirement: 'Teach me networking',
    });

    const adopted = await adoptCheckpointSessionId(
      '  Teach me networking ',
      (checkpoint) => checkpoint.sessionId,
    );

    expect(adopted).toBe('old-session');
  });

  test('does not adopt a checkpoint for a different requirement', async () => {
    kvGet.mockResolvedValue({
      sessionId: 'old-session',
      syllabus: { units: [] },
      outlines: [],
      completedUnitCount: 3,
      requirement: 'Teach me networking',
    });

    const adopted = await adoptCheckpointSessionId('Teach me pottery', (c) => c.sessionId);
    expect(adopted).toBeUndefined();
  });

  test('does not adopt an empty checkpoint (no completed units)', async () => {
    kvGet.mockResolvedValue({
      sessionId: 'old-session',
      syllabus: { units: [] },
      outlines: [],
      completedUnitCount: 0,
      requirement: 'Teach me networking',
    });

    const adopted = await adoptCheckpointSessionId('Teach me networking', (c) => c.sessionId);
    expect(adopted).toBeUndefined();
  });

  test('a fresh session is safe when the checkpoint is unreadable', async () => {
    kvGet.mockRejectedValue(new Error('kv unavailable'));

    const adopted = await adoptCheckpointSessionId('Teach me networking', (c) => c.sessionId);
    expect(adopted).toBeUndefined();
  });
});
