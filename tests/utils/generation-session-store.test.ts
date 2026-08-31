import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const generationSessionsMock = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  where: vi.fn(),
}));

/** Where-query mock returned by `where('session.stageId')`. */
const stageQueryMock = vi.hoisted(() => ({
  equals: vi.fn(),
  toArray: vi.fn(),
  delete: vi.fn(),
}));

function mockStageQuery(records: unknown[]) {
  generationSessionsMock.where.mockReturnValue(stageQueryMock);
  stageQueryMock.equals.mockReturnValue(stageQueryMock);
  stageQueryMock.toArray.mockResolvedValue(records);
  stageQueryMock.delete.mockResolvedValue(undefined);
}

vi.mock('@/lib/utils/database', () => ({
  db: {
    generationSessions: generationSessionsMock,
  },
}));

import {
  clearGenerationSession,
  clearGenerationSessionEnvelope,
  clearGenerationSessionForStage,
  hasGenerationSessionEnvelope,
  loadGenerationParams,
  loadGenerationSession,
  readGenerationSessionEnvelope,
  saveGenerationSession,
} from '@/lib/utils/generation-session-store';
import type { GenerationSessionState } from '@/lib/types/generation';

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index) => Array.from(map.keys())[index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, String(value));
    },
  };
}

const sessionStorageMock = createMemoryStorage();

const baseSession: GenerationSessionState = {
  sessionId: 'session_test1234',
  requirements: { requirement: '讲解光合作用' },
  pdfText: '',
  currentStep: 'generating',
};

beforeAll(() => {
  vi.stubGlobal('sessionStorage', sessionStorageMock);
});

beforeEach(() => {
  sessionStorageMock.clear();
  generationSessionsMock.get.mockReset();
  generationSessionsMock.put.mockReset();
  generationSessionsMock.delete.mockReset();
  generationSessionsMock.where.mockReset();
  generationSessionsMock.put.mockResolvedValue(undefined);
  generationSessionsMock.delete.mockResolvedValue(undefined);
});

describe('generation session store', () => {
  it('saves the full record and writes a pointer envelope', async () => {
    generationSessionsMock.get.mockResolvedValue(undefined);

    await saveGenerationSession({ ...baseSession, stageId: 'stage_abc' });

    expect(generationSessionsMock.put).toHaveBeenCalledTimes(1);
    const record = generationSessionsMock.put.mock.calls[0][0];
    expect(record.sessionId).toBe('session_test1234');
    expect(record.session.stageId).toBe('stage_abc');
    expect(typeof record.createdAt).toBe('number');
    expect(typeof record.updatedAt).toBe('number');

    const envelope = JSON.parse(sessionStorageMock.getItem('generationSession') ?? 'null');
    expect(envelope).toEqual({ sessionId: 'session_test1234', stageId: 'stage_abc' });
  });

  it('preserves createdAt across updates and refreshes updatedAt', async () => {
    const originalCreatedAt = 1000;
    generationSessionsMock.get.mockResolvedValue({
      sessionId: 'session_test1234',
      session: baseSession,
      createdAt: originalCreatedAt,
      updatedAt: 1000,
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(5000);
      await saveGenerationSession(baseSession);
      const record = generationSessionsMock.put.mock.calls[0][0];
      expect(record.createdAt).toBe(originalCreatedAt);
      expect(record.updatedAt).toBe(5000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a session without a sessionId', async () => {
    await expect(
      saveGenerationSession({ ...baseSession, sessionId: '' }),
    ).rejects.toThrow('sessionId');
  });

  it('does not fail the save when the envelope write is rejected', async () => {
    generationSessionsMock.get.mockResolvedValue(undefined);
    const setItem = sessionStorageMock.setItem;
    sessionStorageMock.setItem = () => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    };

    await expect(saveGenerationSession(baseSession)).resolves.toBeUndefined();
    expect(generationSessionsMock.put).toHaveBeenCalledTimes(1);
    sessionStorageMock.setItem = setItem;
  });

  it('loads the IndexedDB record in preference to a legacy sessionStorage payload', async () => {
    sessionStorageMock.setItem(
      'generationSession',
      JSON.stringify({ ...baseSession, pdfText: 'legacy' }),
    );
    generationSessionsMock.get.mockResolvedValue({
      sessionId: 'session_test1234',
      session: { ...baseSession, pdfText: 'from-idb' },
      createdAt: 1,
      updatedAt: 2,
    });

    await expect(loadGenerationSession()).resolves.toMatchObject({ pdfText: 'from-idb' });
  });

  it('falls back to the legacy full payload when no record exists', async () => {
    sessionStorageMock.setItem(
      'generationSession',
      JSON.stringify({ ...baseSession, pdfText: 'legacy payload' }),
    );
    generationSessionsMock.get.mockResolvedValue(undefined);

    await expect(loadGenerationSession()).resolves.toMatchObject({
      sessionId: 'session_test1234',
      pdfText: 'legacy payload',
    });
  });

  it('returns null when nothing is parked', async () => {
    await expect(loadGenerationSession()).resolves.toBeNull();
  });

  it('returns null when the payload is not parseable', async () => {
    sessionStorageMock.setItem('generationSession', '{not json');
    await expect(loadGenerationSession()).resolves.toBeNull();
  });

  it('clears the envelope and the record', async () => {
    sessionStorageMock.setItem(
      'generationSession',
      JSON.stringify({ sessionId: 'session_test1234' }),
    );
    await clearGenerationSession();

    expect(sessionStorageMock.getItem('generationSession')).toBeNull();
    expect(generationSessionsMock.delete).toHaveBeenCalledWith('session_test1234');
  });

  it('clears the envelope without touching the record', async () => {
    sessionStorageMock.setItem(
      'generationSession',
      JSON.stringify({ sessionId: 'session_test1234', stageId: 'stage_abc' }),
    );

    clearGenerationSessionEnvelope();

    expect(sessionStorageMock.getItem('generationSession')).toBeNull();
    expect(generationSessionsMock.delete).not.toHaveBeenCalled();
  });

  it('reports envelope presence and exposes the stageId', () => {
    expect(hasGenerationSessionEnvelope()).toBe(false);
    expect(readGenerationSessionEnvelope()).toBeNull();

    sessionStorageMock.setItem(
      'generationSession',
      JSON.stringify({ sessionId: 'session_test1234', stageId: 'stage_abc' }),
    );

    expect(hasGenerationSessionEnvelope()).toBe(true);
    expect(readGenerationSessionEnvelope()).toEqual({
      sessionId: 'session_test1234',
      stageId: 'stage_abc',
    });
  });

  it('loads generationParams by stage id from the session record', async () => {
    mockStageQuery([
      {
        sessionId: 'session_old',
        session: { ...baseSession, generationParams: { userProfile: 'older run' } },
        createdAt: 1,
        updatedAt: 100,
      },
      {
        sessionId: 'session_latest',
        session: {
          ...baseSession,
          stageId: 'stage_abc',
          generationParams: { userProfile: 'Student: Ada', languageDirective: 'Use English.' },
        },
        createdAt: 2,
        updatedAt: 200,
      },
    ]);

    await expect(loadGenerationParams('stage_abc')).resolves.toEqual({
      userProfile: 'Student: Ada',
      languageDirective: 'Use English.',
    });
    expect(generationSessionsMock.where).toHaveBeenCalledWith('session.stageId');
    expect(stageQueryMock.equals).toHaveBeenCalledWith('stage_abc');
  });

  it('falls back to the legacy standalone generationParams payload', async () => {
    mockStageQuery([]);
    sessionStorageMock.setItem(
      'generationSession',
      JSON.stringify(baseSession),
    );
    sessionStorageMock.setItem(
      'generationParams',
      JSON.stringify({ agents: [{ id: 'a1', name: 'T', role: 'teacher' }] }),
    );

    await expect(loadGenerationParams('stage_abc')).resolves.toEqual({
      agents: [{ id: 'a1', name: 'T', role: 'teacher' }],
    });
  });

  it('returns null generationParams when neither source has them', async () => {
    mockStageQuery([]);
    sessionStorageMock.setItem('generationSession', JSON.stringify(baseSession));

    await expect(loadGenerationParams('stage_abc')).resolves.toBeNull();
  });

  it('clears all records for a stage plus a matching envelope', async () => {
    sessionStorageMock.setItem(
      'generationSession',
      JSON.stringify({ sessionId: 'session_test1234', stageId: 'stage_abc' }),
    );
    mockStageQuery([]);

    await clearGenerationSessionForStage('stage_abc');

    expect(sessionStorageMock.getItem('generationSession')).toBeNull();
    expect(generationSessionsMock.where).toHaveBeenCalledWith('session.stageId');
    expect(stageQueryMock.delete).toHaveBeenCalled();
  });

  it('keeps the envelope when it points at a different stage', async () => {
    sessionStorageMock.setItem(
      'generationSession',
      JSON.stringify({ sessionId: 'session_other', stageId: 'stage_other' }),
    );
    mockStageQuery([]);

    await clearGenerationSessionForStage('stage_abc');

    expect(sessionStorageMock.getItem('generationSession')).not.toBeNull();
    expect(stageQueryMock.delete).toHaveBeenCalled();
  });
});
