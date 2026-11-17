import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMediaGenerationStore, type MediaTask } from '@/lib/store/media-generation';

function task(elementId: string, overrides: Partial<MediaTask> = {}): MediaTask {
  return {
    elementId,
    type: 'video',
    status: 'generating',
    prompt: 'A clip',
    params: {},
    retryCount: 0,
    stageId: 'stage-1',
    ...overrides,
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

describe('media task completion', () => {
  it('releases the URLs a completed task no longer displays', () => {
    useMediaGenerationStore.setState({
      tasks: {
        gen_a: task('gen_a', {
          status: 'done',
          objectUrl: 'blob:old',
          poster: 'blob:old-poster',
        }),
      },
    });

    useMediaGenerationStore.getState().markDone('gen_a', 'blob:new', 'blob:new-poster');

    expect(useMediaGenerationStore.getState().tasks.gen_a).toMatchObject({
      status: 'done',
      objectUrl: 'blob:new',
      poster: 'blob:new-poster',
    });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:old');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:old-poster');
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:new');
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:new-poster');
  });

  it('keeps a URL the task still displays when completion repeats it', () => {
    useMediaGenerationStore.setState({
      tasks: {
        gen_a: task('gen_a', {
          status: 'done',
          objectUrl: 'blob:kept',
          poster: 'blob:kept-poster',
        }),
      },
    });

    useMediaGenerationStore.getState().markDone('gen_a', 'blob:kept', 'blob:kept-poster');

    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('clears a stale error code so a completed task does not read as retryable', () => {
    useMediaGenerationStore.setState({
      tasks: {
        gen_a: task('gen_a', {
          status: 'failed',
          error: 'Upload refused',
          errorCode: 'ASSET_QUOTA_EXCEEDED',
        }),
      },
    });

    useMediaGenerationStore.getState().markDone('gen_a', 'blob:new');

    const stored = useMediaGenerationStore.getState().tasks.gen_a;
    expect(stored).toMatchObject({ status: 'done', objectUrl: 'blob:new' });
    expect(stored.error).toBeUndefined();
    expect(stored.errorCode).toBeUndefined();
  });

  it('leaves a durable hosted URL alone when a task is completed again', () => {
    const previous = '/api/classroom-media/stage-1/media/old.mp4';
    useMediaGenerationStore.setState({
      tasks: {
        gen_a: task('gen_a', {
          status: 'done',
          objectUrl: previous,
        }),
      },
    });

    useMediaGenerationStore
      .getState()
      .markDone('gen_a', '/api/classroom-media/stage-1/media/new.mp4');

    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});
