import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Legacy outline recovery in `loadStageData`.
 *
 * Decks whose outline-carrying flush never reached the document envelope
 * (older builds, or a run whose flushes failed) leave their plans only in
 * the legacy Dexie tables: `stageOutlines` (resume-on-refresh outlines)
 * and `generationSessions` (flat `sceneOutlines` checkpoints). The load
 * path must adopt them read-only so the deck regains its resume cursor;
 * the next flush then carries the adopted outline into the document (and
 * the server copy under server-backed persistence).
 *
 * The resume pipeline is order-based (`generateRemaining` matches outlines
 * to scenes by `order`), so a recovered plan resumes past materialized
 * scenes without re-running them.
 */

const { accessDocumentMock, dbMock } = vi.hoisted(() => ({
  accessDocumentMock: vi.fn(),
  dbMock: {
    isOpen: vi.fn(() => true),
    open: vi.fn(async () => undefined),
    stageOutlines: { get: vi.fn() },
    generationSessions: {
      where: vi.fn(),
    },
  },
}));

vi.mock('@/lib/document-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document-store')>()),
  accessDocument: (...args: unknown[]) => accessDocumentMock(...args),
}));

vi.mock('@/lib/utils/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils/database')>()),
  db: dbMock,
}));

vi.mock('@/lib/utils/chat-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils/chat-storage')>()),
  loadChatSessions: vi.fn(async () => []),
  saveChatSessions: vi.fn(async () => undefined),
}));

vi.mock('@/lib/playback/cursor', () => ({
  clearCursor: vi.fn(async () => undefined),
}));

vi.mock('@/lib/document-store/current-scene', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document-store/current-scene')>()),
  loadCurrentScene: vi.fn(async () => undefined),
}));

vi.mock('@/lib/quiz/persistence', () => ({
  clearAllForScene: vi.fn(async () => undefined),
}));

vi.mock('@/lib/runtime/store', () => ({
  beginStageRuntimeDeletionSafely: vi.fn(async () => undefined),
}));

vi.mock('@/lib/pbl/v2/runtime/drain', () => ({
  clearStageDrainWatermarks: vi.fn(async () => undefined),
}));

import { loadStageData } from '@/lib/utils/stage-storage';
import type { AppDocument } from '@/lib/document-store';
import type { SceneOutline } from '@/lib/types/generation';

const STAGE_ID = 'stage-recovery';

function makeStageDocument(): NonNullable<AppDocument> {
  return {
    dslVersion: '0.2.0',
    stage: {
      id: STAGE_ID,
      name: 'Recovered course',
      createdAt: 1_000,
      updatedAt: 2_000,
    },
    scenes: [],
  };
}

function makeOutline(id: string, order: number): SceneOutline {
  return {
    id,
    order,
    type: 'slide',
    title: `Scene ${order}`,
    description: 'Teach the topic',
    keyPoints: ['point'],
  } as unknown as SceneOutline;
}

function stubGenerationSessions(records: Array<Record<string, unknown>>): void {
  dbMock.generationSessions.where.mockReturnValue({
    equals: vi.fn().mockReturnValue({
      toArray: vi.fn().mockResolvedValue(records),
    }),
  });
}

beforeEach(() => {
  accessDocumentMock.mockReset();
  dbMock.isOpen.mockReset().mockReturnValue(true);
  dbMock.open.mockReset().mockResolvedValue(undefined);
  dbMock.stageOutlines.get.mockReset().mockResolvedValue(undefined);
  dbMock.generationSessions.where.mockReset();
  stubGenerationSessions([]);
});

describe('legacy outline recovery', () => {
  it('adopts the legacy stageOutlines row when the document carries no outline', async () => {
    accessDocumentMock.mockResolvedValue({
      document: makeStageDocument(),
      readOnlyLegacy: false,
    });
    dbMock.stageOutlines.get.mockResolvedValue({
      stageId: STAGE_ID,
      outlines: [makeOutline('o1', 1), makeOutline('o2', 2)],
      generationComplete: false,
      createdAt: 1_500,
      updatedAt: 2_500,
    });

    const data = await loadStageData(STAGE_ID);

    expect(data).not.toBeNull();
    expect(data?.outline).toMatchObject({
      outlines: [expect.objectContaining({ id: 'o1' }), expect.objectContaining({ id: 'o2' })],
      generationComplete: false,
      createdAt: 1_500,
      updatedAt: 2_500,
    });
  });

  it('falls back to the latest generationSessions checkpoint when the legacy row is absent', async () => {
    accessDocumentMock.mockResolvedValue({
      document: makeStageDocument(),
      readOnlyLegacy: false,
    });
    stubGenerationSessions([
      {
        sessionId: 'session-old',
        createdAt: 1_000,
        updatedAt: 2_000,
        session: { sceneOutlines: [makeOutline('stale', 1)] },
      },
      {
        sessionId: 'session-new',
        createdAt: 3_000,
        updatedAt: 4_000,
        session: { sceneOutlines: [makeOutline('fresh-1', 1), makeOutline('fresh-2', 2)] },
      },
    ]);

    const data = await loadStageData(STAGE_ID);

    expect(data?.outline).toMatchObject({
      outlines: [
        expect.objectContaining({ id: 'fresh-1' }),
        expect.objectContaining({ id: 'fresh-2' }),
      ],
      createdAt: 3_000,
      updatedAt: 4_000,
    });
  });

  it('prefers the document outline over any legacy source', async () => {
    accessDocumentMock.mockResolvedValue({
      document: {
        ...makeStageDocument(),
        outline: {
          outlines: [makeOutline('document', 1)],
          generationComplete: true,
          createdAt: 5_000,
          updatedAt: 6_000,
        },
      },
      readOnlyLegacy: false,
    });
    dbMock.stageOutlines.get.mockResolvedValue({
      stageId: STAGE_ID,
      outlines: [makeOutline('legacy', 1)],
      createdAt: 1_000,
      updatedAt: 2_000,
    });

    const data = await loadStageData(STAGE_ID);

    expect(data?.outline).toMatchObject({
      outlines: [expect.objectContaining({ id: 'document' })],
    });
    expect(dbMock.stageOutlines.get).not.toHaveBeenCalled();
  });

  it('returns no outline when neither legacy source holds one', async () => {
    accessDocumentMock.mockResolvedValue({
      document: makeStageDocument(),
      readOnlyLegacy: false,
    });
    dbMock.stageOutlines.get.mockResolvedValue({
      stageId: STAGE_ID,
      outlines: [],
      createdAt: 1,
      updatedAt: 1,
    });

    const data = await loadStageData(STAGE_ID);

    expect(data).not.toBeNull();
    expect(data?.outline).toBeUndefined();
  });

  it('recovers read-only: a Dexie failure degrades to no outline instead of failing the load', async () => {
    accessDocumentMock.mockResolvedValue({
      document: makeStageDocument(),
      readOnlyLegacy: false,
    });
    dbMock.isOpen.mockReturnValue(false);
    dbMock.open.mockRejectedValue(new Error('dexie closed'));

    const data = await loadStageData(STAGE_ID);

    expect(data).not.toBeNull();
    expect(data?.outline).toBeUndefined();
  });
});
