import { describe, expect, it } from 'vitest';

import { singleFlight, singleFlightCount } from '@/lib/server/single-flight';

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('singleFlight', () => {
  it('coalesces concurrent calls for the same key into one run', async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = async () => {
      runs += 1;
      await gate;
      return 'done';
    };

    const first = singleFlight('coalesce', task);
    const second = singleFlight('coalesce', task);
    expect(second).toBe(first);

    release();
    await expect(first).resolves.toBe('done');
    await expect(second).resolves.toBe('done');
    expect(runs).toBe(1);

    await settle();
    expect(singleFlightCount()).toBe(0);
  });

  it('runs different keys independently', async () => {
    let runs = 0;
    const task = async () => {
      const id = (runs += 1);
      await settle();
      return id;
    };
    const [a, b] = await Promise.all([singleFlight('key-a', task), singleFlight('key-b', task)]);
    expect(runs).toBe(2);
    expect(new Set([a, b]).size).toBe(2);

    await settle();
    expect(singleFlightCount()).toBe(0);
  });

  it('re-runs after the previous flight settles', async () => {
    let runs = 0;
    const task = async () => {
      runs += 1;
      return runs;
    };
    expect(await singleFlight('sequential', task)).toBe(1);
    await settle();
    expect(await singleFlight('sequential', task)).toBe(2);
    await settle();
    expect(singleFlightCount()).toBe(0);
  });

  it('propagates rejection to every waiter, then accepts a retry', async () => {
    const failing = singleFlight('retry', async () => {
      throw new Error('boom');
    });
    const alsoFailing = singleFlight('retry', async () => {
      throw new Error('never runs');
    });
    await expect(failing).rejects.toThrow('boom');
    await expect(alsoFailing).rejects.toThrow('boom');

    await settle();
    expect(singleFlightCount()).toBe(0);

    let retried = false;
    await singleFlight('retry', async () => {
      retried = true;
      return 'recovered';
    });
    expect(retried).toBe(true);
    await settle();
    expect(singleFlightCount()).toBe(0);
  });
});
