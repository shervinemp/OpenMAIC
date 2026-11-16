'use client';

import { useCallback, useSyncExternalStore } from 'react';

const subscribeToNothing = () => () => {};
const getFalseOnTheServer = () => false;

/**
 * Subscribe to a CSS media query. SSR resolves to `false` (the desktop
 * first-paint), and the real answer lands on hydration — the same
 * no-layout-shift contract the rest of the shell uses for width-dependent
 * chrome.
 *
 * `useSyncExternalStore` is deliberate: event handlers + `useState` leave a
 * stale value for a frame after a cross-breakpoint resize, and this value
 * gates whether the scene sidebar is an overlay or a flex sibling.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return subscribeToNothing();
      }
      const mediaQuery = window.matchMedia(query);
      mediaQuery.addEventListener('change', onStoreChange);
      return () => mediaQuery.removeEventListener('change', onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, getFalseOnTheServer);
}
