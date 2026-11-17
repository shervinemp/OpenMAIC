import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMediaGenerationStore, type MediaTask } from '@/lib/store/media-generation';

function task(elementId: string): MediaTask {
  return {
    elementId,
    type: 'image',
    status: 'generating',
    prompt: 'A diagram',
    params: {},
    retryCount: 0,
    stageId: 'stage-1',
  };
}

let revokeObjectURL: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  revokeObjectURL.mockRestore();
  useMediaGenerationStore.setState({ tasks: {} });
});

describe('media task re-keying', () => {
  it('keeps the first task when two placeholders share one allocated asset', () => {
    useMediaGenerationStore.setState({
      tasks: { gen_a: task('gen_a'), gen_b: task('gen_b') },
    });

    const store = useMediaGenerationStore.getState();
    store.rekeyDone('gen_a', 'ast_shared', 'blob:a');
    store.rekeyDone('gen_b', 'ast_shared', 'blob:b');

    const tasks = useMediaGenerationStore.getState().tasks;
    expect(tasks.gen_a).toBeUndefined();
    expect(tasks.gen_b).toBeUndefined();
    expect(tasks.ast_shared).toMatchObject({
      elementId: 'ast_shared',
      placeholderRef: 'gen_a',
      status: 'done',
      objectUrl: 'blob:a',
    });
    // The duplicate's URL was minted for a task this update discarded, so it
    // is released instead of pinning the shared bytes for the tab's lifetime.
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:b');
  });

  it('releases a discarded duplicate task’s displayed URL and poster', () => {
    useMediaGenerationStore.setState({
      tasks: {
        gen_a: task('gen_a'),
        // The held path marks the duplicate done under its placeholder before
        // reconciliation re-keys it onto the shared asset.
        gen_b: {
          ...task('gen_b'),
          status: 'done',
          objectUrl: 'blob:b',
          poster: 'blob:b-poster',
        },
      },
    });

    const store = useMediaGenerationStore.getState();
    store.rekeyDone('gen_a', 'ast_shared', 'blob:a');
    store.rekeyDone('gen_b', 'ast_shared', 'blob:b', 'blob:b-poster');

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:b');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:b-poster');
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:a');
  });

  it('leaves durable hosted poster URLs alone when a duplicate task is dropped', () => {
    const hostedPoster = '/api/classroom-media/stage-1/media/poster.png';
    useMediaGenerationStore.setState({
      tasks: {
        gen_a: task('gen_a'),
        gen_b: {
          ...task('gen_b'),
          status: 'done',
          objectUrl: 'blob:b',
          poster: hostedPoster,
        },
      },
    });

    const store = useMediaGenerationStore.getState();
    store.rekeyDone('gen_a', 'ast_shared', 'blob:a');
    store.rekeyDone('gen_b', 'ast_shared', 'blob:b', hostedPoster);

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:b');
    expect(revokeObjectURL).not.toHaveBeenCalledWith(hostedPoster);
  });
});
