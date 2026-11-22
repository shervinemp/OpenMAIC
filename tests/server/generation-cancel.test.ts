import { describe, expect, it } from 'vitest';

import {
  activeGenerationLabels,
  cancelAllGenerations,
  cancelGeneration,
  getGenerationAbortSignal,
  runWithGenerationCancel,
} from '@/lib/server/generation-cancel';

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

describe('browser generation cancellation', () => {
  it('aborts every in-flight call for the named session only', async () => {
    const signals: AbortSignal[] = [];
    let bothReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      bothReady = resolve;
    });

    const work = (count: number) =>
      Array.from({ length: count }, () =>
        runWithGenerationCancel('session-a', '/api/documents/index', async () => {
          const signal = getGenerationAbortSignal()!;
          signals.push(signal);
          if (signals.length === 3) bothReady();
          await waitForAbort(signal);
        }),
      );

    const pending = [...work(2), ...runSessionB()];
    await ready;

    expect(activeGenerationLabels()).toHaveLength(3);
    expect(cancelGeneration('session-a')).toBe(2);
    expect(signals.slice(0, 2).every((s) => s.aborted)).toBe(true);
    expect(signals[2]?.aborted).toBe(false);

    expect(cancelGeneration('session-a')).toBe(0);
    expect(cancelAllGenerations()).toBe(1);
    await Promise.all(pending);
    expect(activeGenerationLabels()).toEqual([]);

    function runSessionB() {
      return [
        runWithGenerationCancel('session-b', '/api/web-search', async () => {
          const signal = getGenerationAbortSignal()!;
          signals.push(signal);
          if (signals.length === 3) bothReady();
          await waitForAbort(signal);
        }),
      ];
    }
  });
});
