/**
 * Deterministic neutral display order for quiz items.
 *
 * `ordering` questions store their options in the correct sequence and
 * `matching` questions align left prompts with their targets, so rendering the
 * stored order would hand the learner the answer. Both therefore render
 * through this helper.
 *
 * The permutation is:
 *   - deterministic — seeded from the question id, so the server, the client
 *     and a reload all agree (no hydration mismatch, no reshuffle on re-render);
 *   - neutral — never the identity permutation when a non-identity one exists;
 *   - stable — depends only on the seed and the item count, not on the values.
 */

/** FNV-1a: small, fast, and good enough to spread short question ids. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — one uint32 of state, uniform enough for a display shuffle. */
function createRandom(state: number): () => number {
  let value = state >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Return a permutation of `0..length-1` in display order. Never the identity
 * order when `length > 1`: a question that happens to hash to the sorted
 * sequence is rotated by one.
 */
export function displayOrder(seed: string, length: number): number[] {
  const size = Math.max(0, Math.floor(length));
  const order = Array.from({ length: size }, (_, index) => index);
  if (size < 2) return order;

  const random = createRandom(hashSeed(seed));
  for (let index = size - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    [order[index], order[swapWith]] = [order[swapWith], order[index]];
  }

  if (order.every((value, index) => value === index)) {
    // Rotate one step: still a fair permutation, and provably not the key.
    const first = order.shift() as number;
    order.push(first);
  }
  return order;
}
