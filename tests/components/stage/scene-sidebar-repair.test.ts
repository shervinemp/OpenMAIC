// @vitest-environment jsdom
// Keep the .test.ts suffix: the repository's Vitest include intentionally
// discovers TypeScript tests with this extension.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));

import { SceneSidebar } from '@/components/stage/scene-sidebar';
import { useStageStore } from '@/lib/store/stage';

describe('scene sidebar course repair', () => {
  let root: Root | undefined;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    useStageStore.setState({
      stage: { id: 'stage-1', name: 'Course' } as never,
      scenes: [],
      outlines: [],
      failedOutlines: [],
      generatingOutlines: [],
      generationStatus: 'completed',
    } as never);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    container.remove();
  });

  function render(props: { onRepairCourse?: () => void; courseRepairing?: boolean }) {
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(SceneSidebar, { collapsed: false, onCollapseChange: () => {}, ...props }),
      );
    });
    return container.querySelector<HTMLButtonElement>('[data-testid="repair-course"]');
  }

  it('offers the repair only when the course may be repaired', () => {
    expect(render({})).toBeNull();
  });

  it('runs a repair pass on click', () => {
    const onRepairCourse = vi.fn();
    const button = render({ onRepairCourse });

    act(() => button!.click());

    expect(onRepairCourse).toHaveBeenCalledOnce();
  });

  it('holds while a pass is running or the course is generating', () => {
    expect(render({ onRepairCourse: vi.fn(), courseRepairing: true })!.disabled).toBe(true);
    act(() => root?.unmount());

    useStageStore.setState({ generationStatus: 'generating' } as never);
    expect(render({ onRepairCourse: vi.fn() })!.disabled).toBe(true);
  });
});
