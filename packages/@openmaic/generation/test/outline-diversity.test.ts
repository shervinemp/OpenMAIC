import { describe, expect, it } from 'vitest';

import { findRedundantOutlinePairs, summarizeRedundantOutlines } from '../src/outline-diversity.js';
import type { SceneOutline } from '../src/outline-types.js';

function outline(id: string, title: string, keyPoints: string[]): SceneOutline {
  return { id, type: 'exercise', title, description: '', keyPoints } as unknown as SceneOutline;
}

describe('outline diversity', () => {
  it('detects two scenes teaching the same worked example', () => {
    const points = [
      'Calculate the latent heat energy by multiplying mass in kilograms by specific latent heat in joules per kilogram.',
      'Check that kilogram units cancel to leave joules in the final answer.',
      'Explain why the temperature stays constant during the phase change.',
    ];
    const pairs = findRedundantOutlinePairs([
      outline('a', 'Worked Example: Latent Heat', points),
      outline('b', 'Worked Calculation: Latent Heat', [...points]),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].overlap).toBeGreaterThan(0.6);
    expect(summarizeRedundantOutlines(pairs)).toContain('Differentiate them');
  });

  it('does not flag unrelated scenes that share domain vocabulary', () => {
    const pairs = findRedundantOutlinePairs([
      outline('a', 'Evaporation definition', [
        'Evaporation happens only at the surface of a liquid below its boiling point.',
      ]),
      outline('b', 'Water cycle diagram', [
        'The sun heats rivers and oceans and water vapour rises into the atmosphere.',
      ]),
    ]);
    expect(pairs).toEqual([]);
  });

  it('ignores trivially short outlines', () => {
    expect(findRedundantOutlinePairs([outline('a', 'A', ['x']), outline('b', 'B', ['x'])])).toEqual(
      [],
    );
  });
});
