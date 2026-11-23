'use client';

import { useEffect, useState } from 'react';

import { readActiveGenerationStageIds } from '@/lib/generation/active-generations';

const POLL_MS = 2_000;

/**
 * Live set of course ids currently generating. Read-only: polling a Web Lock
 * query and the durable intent, never touching either one.
 */
export function useActiveGenerationStageIds(): ReadonlySet<string> {
  const [active, setActive] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const ids = await readActiveGenerationStageIds();
      if (!cancelled) setActive(ids);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return active;
}
