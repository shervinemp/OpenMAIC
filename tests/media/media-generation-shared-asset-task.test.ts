import { afterEach, describe, expect, it } from 'vitest';

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

afterEach(() => {
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
  });
});
