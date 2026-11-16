// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMediaQuery } from '@/lib/hooks/use-media-query';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class MockMediaQueryList {
  matches: boolean;
  readonly media: string;
  onchange: ((event: MediaQueryListEvent) => void) | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(query: string, matches: boolean) {
    this.media = query;
    this.matches = matches;
  }

  addEventListener = vi.fn((_type: 'change', listener: () => void) => {
    this.listeners.add(listener);
  });

  removeEventListener = vi.fn((_type: 'change', listener: () => void) => {
    this.listeners.delete(listener);
  });

  setMatches(matches: boolean) {
    this.matches = matches;
    for (const listener of this.listeners) listener();
  }

  addListener() {}
  removeListener() {}
  dispatchEvent() {
    return true;
  }
}

let mediaQuery: MockMediaQueryList;

function Probe() {
  const compact = useMediaQuery('(max-width: 1023px)');
  return createElement('output', { 'data-testid': 'state' }, compact ? 'compact' : 'wide');
}

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(Probe)));
  return { container, root };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('useMediaQuery', () => {
  it('follows matchMedia changes and unsubscribes on unmount', () => {
    mediaQuery = new MockMediaQueryList('(max-width: 1023px)', false);
    vi.stubGlobal('matchMedia', () => mediaQuery);
    const { container, root } = mount();

    expect(container.querySelector('[data-testid="state"]')?.textContent).toBe('wide');
    act(() => mediaQuery.setMatches(true));
    expect(container.querySelector('[data-testid="state"]')?.textContent).toBe('compact');
    act(() => mediaQuery.setMatches(false));
    expect(container.querySelector('[data-testid="state"]')?.textContent).toBe('wide');

    act(() => root.unmount());
    expect(mediaQuery.removeEventListener).toHaveBeenCalled();
  });
});
