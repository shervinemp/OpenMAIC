import { describe, expect, it } from 'vitest';
import { displayOrder } from '@/lib/quiz/shuffle';

describe('displayOrder', () => {
  it('returns a permutation of the indexes', () => {
    const order = displayOrder('q1', 5);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it('is deterministic for the same seed and length', () => {
    expect(displayOrder('question-42', 6)).toEqual(displayOrder('question-42', 6));
  });

  it('never returns the identity order when another order exists', () => {
    for (let index = 0; index < 250; index += 1) {
      const order = displayOrder(`q_${index}`, 4);
      expect(order).not.toEqual([0, 1, 2, 3]);
      expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    }
  });

  it('handles empty and single-item questions', () => {
    expect(displayOrder('q', 0)).toEqual([]);
    expect(displayOrder('q', 1)).toEqual([0]);
    expect(displayOrder('q', -3)).toEqual([]);
  });

  it('varies across seeds', () => {
    const orders = new Set(['a', 'b', 'c', 'd', 'e'].map((seed) => displayOrder(seed, 5).join('')));
    expect(orders.size).toBeGreaterThan(1);
  });
});
