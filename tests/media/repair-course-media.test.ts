import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Class-agnostic media repair (lib/media/repair-course-media.ts).
 *
 * The contract under test: a ref is pending iff the bytes it would be PLAYED
 * with do not resolve through the player's own chain — narration through
 * resolveAudioBlob (pool → mirror → server), every other renderer-visible
 * asset through resolveStoredBytes (pool → compat row → task URL).
 * elementId refs are NOT probed here; the orchestrator owns that class and
 * is dispatched once, filtered to outlines whose scene actually exists.
 */

const mocks = vi.hoisted(() => ({
  drainPendingSceneTTS: vi.fn(),
  generateMediaForOutlines: vi.fn(),
  resolveAudioBlob: vi.fn(),
  resolveStoredBytes: vi.fn(),
}));

vi.mock('@/lib/hooks/use-scene-generator', () => ({
  drainPendingSceneTTS: mocks.drainPendingSceneTTS,
}));

vi.mock('@/lib/media/media-orchestrator', () => ({
  generateMediaForOutlines: mocks.generateMediaForOutlines,
}));

vi.mock('@/lib/media/resolve-audio-bytes', () => ({
  resolveAudioBlob: mocks.resolveAudioBlob,
}));

vi.mock('@/lib/media/resolve-stored-bytes', () => ({
  resolveStoredBytes: mocks.resolveStoredBytes,
}));

import { repairCourseMedia } from '@/lib/media/repair-course-media';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

const AUDIO_BYTES = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
const MEDIA_BYTES = new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' });

function scene(input: {
  id: string;
  order: number;
  audioIds: Array<string | undefined>;
  srcRefs?: string[];
}): Scene {
  return {
    id: input.id,
    order: input.order,
    actions: input.audioIds.map((audioId, i) => ({
      type: 'speech',
      id: `a${i}`,
      text: `clip ${i}`,
      ...(audioId ? { audioId } : {}),
    })),
    content: {
      canvas: {
        elements: (input.srcRefs ?? []).map((src) => ({ type: 'image', id: `el-${src}`, src })),
      },
    },
  } as unknown as Scene;
}

function outline(id: string, order: number, elementIds: string[]): SceneOutline {
  return {
    id,
    order,
    type: 'slide',
    title: `Outline ${id}`,
    description: '',
    keyPoints: [],
    mediaGenerations: elementIds.map((elementId) => ({
      elementId,
      type: 'image' as const,
      prompt: `media for ${elementId}`,
    })),
  };
}

describe('repairCourseMedia — class-agnostic byte detection', () => {
  beforeEach(() => {
    mocks.drainPendingSceneTTS.mockReset();
    mocks.generateMediaForOutlines.mockReset().mockResolvedValue(undefined);
    mocks.resolveAudioBlob.mockReset();
    mocks.resolveStoredBytes.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a fully resolving deck dispatches nothing and reports zero pending', async () => {
    mocks.resolveAudioBlob.mockResolvedValue(AUDIO_BYTES);
    mocks.resolveStoredBytes.mockResolvedValue(MEDIA_BYTES);
    mocks.drainPendingSceneTTS.mockResolvedValue(0);

    const report = await repairCourseMedia(
      [
        scene({ id: 's1', order: 1, audioIds: ['tts_s1_a0'], srcRefs: ['gen_img_1'] }),
      ],
      {
        outlines: [outline('o1', 1, ['gen_img_1'])],
        stageId: 'stage-1',
        passes: 2,
      },
    );

    expect(mocks.generateMediaForOutlines).not.toHaveBeenCalledWith(
      expect.anything(),
      'stage-1',
      expect.anything(),
    );
    expect(report).toMatchObject({
      audioRestored: 0,
      audioStillPending: 0,
      mediaPending: 0,
      mediaRequeued: 0,
      mediaUnrecoverable: 0,
      narrationPassesRun: 1,
    });
  });

  it('dead narration bytes drive the drain, which restores them (post-audit resolves)', async () => {
    mocks.resolveAudioBlob
      // Detection: dead. Post-audit: resolves — the drain fixed them.
      .mockReturnValueOnce(Promise.resolve(null))
      .mockReturnValueOnce(Promise.resolve(AUDIO_BYTES));
    // Pass 1 restores, pass 2 finds nothing pending and stops the sweep.
    mocks.drainPendingSceneTTS.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const report = await repairCourseMedia(
      [scene({ id: 's1', order: 1, audioIds: ['tts_s1_a0'] })],
      { passes: 2 },
    );

    // Delegation happened, the drain ran, and the honest post-audit respects it.
    expect(report.audioRestored).toBe(1);
    expect(report.audioStillPending).toBe(0);
  });

  it('dead media refs with a covered task spec requeue the orchestrator and count unrecoverable only for uncovered refs', async () => {
    // gen_img_1 has bytes (covered, but the src IS dead per resolveStoredBytes);
    mocks.resolveStoredBytes
      .mockResolvedValueOnce(null) // gen_img_1 dead
      .mockResolvedValueOnce(null); // gen_img_2 dead (no task spec also)
    mocks.drainPendingSceneTTS.mockResolvedValue(0);

    const deckOutline = outline('o1', 1, ['gen_img_1']);
    const outlineWithoutScene = outline('o2', 99, ['gen_img_orphan']);
    const orphanScene = scene({ id: 'orphan', order: 7, audioIds: [] });

    const report = await repairCourseMedia(
      [scene({ id: 's1', order: 1, audioIds: ['tts_ok'], srcRefs: ['gen_img_1', 'gen_img_2'] }), orphanScene],
      {
        outlines: [deckOutline, outlineWithoutScene],
        stageId: 'stage-1',
      },
    );

    expect(report.mediaPending).toBe(2);
    expect(report.mediaUnrecoverable).toBe(1);
    // Only the materialized outline is dispatched — the orphaned outline
    // (order 99 — no scene) must not have its media queue paid for.
    const dispatchCall = mocks.generateMediaForOutlines.mock.calls[0];
    expect(dispatchCall[0]).toEqual([deckOutline]);
  });

  it('audio probes with an unresolvable narration ref counts audioStillPending without position blur across scenes', async () => {
    mocks.resolveAudioBlob
      .mockReturnValueOnce(Promise.resolve(null)) // s1 clip dead
      .mockReturnValueOnce(Promise.resolve(AUDIO_BYTES)) // s2 clip alive
      .mockReturnValueOnce(Promise.resolve(null)); // post-audit: s1 still dead
    mocks.drainPendingSceneTTS.mockResolvedValue(0);

    const report = await repairCourseMedia(
      [
        scene({ id: 's1', order: 1, audioIds: ['tts_s1_a0'] }),
        scene({ id: 's2', order: 2, audioIds: ['tts_s2_a0'] }),
      ],
      {},
    );

    expect(report.audioStillPending).toBe(1);
  });

  it('narration ilma prefix-less ids (functional AssetRef) still routed via the audio path when shaped tts_/audio_/speech_', async () => {
    mocks.resolveAudioBlob.mockResolvedValue(AUDIO_BYTES);
    mocks.drainPendingSceneTTS.mockResolvedValue(0);

    const report = await repairCourseMedia(
      [scene({ id: 's1', order: 1, audioIds: ['speech_abc', 'audio_leg2'] })],
      {},
    );

    // Both narration ids were resolved through the audio chain; report clean.
    expect(report.audioStillPending).toBe(0);
    expect(mocks.resolveAudioBlob.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['speech_abc', 'audio_leg2']),
    );
  });
});
