import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadStageDataMock } = vi.hoisted(() => ({ loadStageDataMock: vi.fn() }));

vi.mock('@/lib/pbl/v2/runtime/hydration', () => ({
  hydratePBLScenesFromRuntime: async (_stageId: string, scenes: unknown[]) => scenes,
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: vi.fn().mockResolvedValue(undefined),
  loadStageData: (...args: unknown[]) => loadStageDataMock(...args),
}));
vi.mock('@/lib/utils/database', () => ({
  db: {
    stageOutlines: { put: vi.fn(), get: vi.fn() },
    stageFolders: { delete: vi.fn().mockResolvedValue(undefined) },
  },
}));

import { useStageStore } from '@/lib/store/stage';

function stored(stageId: string, outline: Record<string, unknown>) {
  return {
    stage: { id: stageId, name: stageId, createdAt: 1, updatedAt: 1 },
    scenes: [],
    currentSceneId: null,
    chats: [],
    outline: { outlines: [], createdAt: 1, updatedAt: 1, ...outline },
  };
}

describe('producer ownership on the classroom load', () => {
  beforeEach(() => {
    useStageStore.getState().clearStore();
    loadStageDataMock.mockReset();
  });

  it('reads the producer and its session handle from the course', async () => {
    loadStageDataMock.mockResolvedValue(
      stored('agent-course', {
        generationComplete: true,
        producer: 'server-job',
        producerRef: 'session-1',
      }),
    );

    await useStageStore.getState().loadFromStorage('agent-course');

    expect(useStageStore.getState().outlineProducer).toBe('server-job');
    expect(useStageStore.getState().outlineProducerRef).toBe('session-1');
  });

  // The singleton store outlives a course: a server-job answer left behind
  // kept the next, client-authored course from ever resuming generation.
  it('does not carry a previous course’s producer into the next one', async () => {
    useStageStore.setState({ outlineProducer: 'server-job', outlineProducerRef: 'session-1' });
    loadStageDataMock.mockResolvedValue(stored('client-course', { generationComplete: false }));

    await useStageStore.getState().loadFromStorage('client-course');

    expect(useStageStore.getState().outlineProducer).toBeNull();
    expect(useStageStore.getState().outlineProducerRef).toBeNull();
  });

  it('forgets the producer when the store is cleared', () => {
    useStageStore.setState({ outlineProducer: 'server-job', outlineProducerRef: 'session-1' });

    useStageStore.getState().clearStore();

    expect(useStageStore.getState().outlineProducer).toBeNull();
    expect(useStageStore.getState().outlineProducerRef).toBeNull();
  });
});
