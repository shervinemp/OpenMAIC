import { describe, expect, it, vi } from 'vitest';

import { correctUntilClean } from '../src/verification-loop.js';

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
    const verdicts = [[{ code: 'a', message: 'first' }], [{ code: 'b', message: 'second' }]];
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
        { code: 'a', message: '1' },
        { code: 'b', message: '2' },
      ],
      [{ code: 'c', message: '1' }],
      [
        { code: 'd', message: '1' },
        { code: 'e', message: '2' },
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
});
