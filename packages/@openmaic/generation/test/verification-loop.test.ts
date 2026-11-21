import { describe, expect, it, vi } from 'vitest';

import { classifyFinding, correctUntilClean, correctiveBudget } from '../src/verification-loop.js';

describe('correctUntilClean', () => {
  it('returns the initial artifact untouched when it is already clean', async () => {
    const generate = vi.fn(async () => 'ok');
    const verify = vi.fn(async () => []);

    const result = await correctUntilClean('initial', {
      generate,
      verify,
      summarize: (issues) => issues.map((issue) => issue.message).join('\n'),
      maxAttempts: 3,
    });

    expect(result).toEqual({ artifact: 'initial', issues: [], passes: 0, clean: true });
    expect(generate).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('re-verifies each rewrite and stops early once clean', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('rewrite')
      .mockResolvedValueOnce('should-not-be-used');
    const verdicts = [[{ code: 'a', message: 'first' }], []];
    const verify = vi.fn(async () => verdicts.shift() ?? []);

    const result = await correctUntilClean('initial', {
      generate,
      verify,
      summarize: (issues) => issues.map((issue) => issue.message).join('\n'),
      maxAttempts: 3,
    });

    expect(result).toEqual({ artifact: 'rewrite', issues: [], passes: 1, clean: true });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('accumulates findings across passes so an earlier fix is not forgotten', async () => {
    const generate = vi.fn(async () => 'rewrite');
    const verdicts = [
      [{ code: 'dead-control', message: 'first' }],
      [{ code: 'dead-control', message: 'second' }],
    ];
    const verify = vi.fn(async () => verdicts.shift() ?? []);
    const summaries: string[] = [];

    await correctUntilClean('initial', {
      generate,
      verify,
      summarize: (issues) => {
        const text = issues.map((issue) => issue.message).join(' + ');
        summaries.push(text);
        return text;
      },
      maxAttempts: 2,
    });

    expect(summaries).toEqual(['first', 'first + second']);
  });

  it('keeps the best artifact on exhaustion and never ships a regressing rewrite', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('one-defect')
      .mockResolvedValueOnce('two-defects');
    const verdicts = [
      [
        { code: 'dead-control', message: '1' },
        { code: 'dead-control', message: '2' },
      ],
      [{ code: 'dead-control', message: '1' }],
      [
        { code: 'dead-control', message: '1' },
        { code: 'dead-control', message: '2' },
      ],
    ];
    const verify = vi.fn(async () => verdicts.shift() ?? []);

    const result = await correctUntilClean('initial', {
      generate,
      verify,
      summarize: (issues) => issues.map((issue) => issue.message).join('\n'),
      maxAttempts: 2,
    });

    expect(result.artifact).toBe('one-defect');
    expect(result.issues).toHaveLength(1);
    expect(result.passes).toBe(2);
    expect(result.clean).toBe(false);
  });

  it('keeps the current artifact and stops when a corrective generation fails', async () => {
    const generate = vi.fn(async (): Promise<string | null> => null);
    const verify = vi.fn(async () => [{ code: 'a', message: 'defect' }]);

    const result = await correctUntilClean('initial', {
      generate,
      verify,
      summarize: (issues) => issues.map((issue) => issue.message).join('\n'),
      maxAttempts: 3,
    });

    expect(result.artifact).toBe('initial');
    expect(result.passes).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('spends at most one pass on a semantic finding even with a larger budget', async () => {
    const generate = vi.fn(async () => 'rewrite');
    const verify = vi.fn(async () => [{ code: 'unsupported-claim', message: 'not supported' }]);

    const result = await correctUntilClean('initial', {
      generate,
      verify,
      summarize: (issues) => issues.map((issue) => issue.message).join('\n'),
      maxAttempts: 3,
    });

    expect(result.passes).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(2);
  });
});

describe('finding classification', () => {
  it('separates mechanical, semantic and environmental findings', () => {
    expect(classifyFinding({ code: 'dead-control', message: 'slider x is dead' })).toBe(
      'mechanical',
    );
    expect(classifyFinding({ code: 'qualifier-conflict', message: 'under 1% vs 1%' })).toBe(
      'mechanical',
    );
    expect(classifyFinding({ code: 'claim-mismatch', message: 'state never advances' })).toBe(
      'semantic',
    );
    expect(
      classifyFinding({
        code: 'script-error',
        message: 'ReferenceError: CanvasRenderingContext2D is not defined',
      }),
    ).toBe('environmental');
    expect(classifyFinding({ code: 'script-error', message: 'TypeError: bad widget state' })).toBe(
      'mechanical',
    );
  });

  it('budgets retries by class instead of uniformly', () => {
    expect(correctiveBudget([], 3)).toBe(0);
    expect(
      correctiveBudget([{ code: 'script-error', message: 'ResizeObserver is not defined' }], 3),
    ).toBe(0);
    expect(correctiveBudget([{ code: 'claim-mismatch', message: 'x' }], 3)).toBe(1);
    expect(correctiveBudget([{ code: 'dead-control', message: 'x' }], 3)).toBe(3);
    expect(
      correctiveBudget(
        [
          { code: 'claim-mismatch', message: 'x' },
          { code: 'dead-control', message: 'y' },
        ],
        3,
      ),
    ).toBe(3);
  });
});
