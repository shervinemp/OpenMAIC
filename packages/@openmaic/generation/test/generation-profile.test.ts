import { afterEach, describe, expect, it } from 'vitest';
import { readGenerationProfile, scaleDepthFloor } from '../src/profile';

/**
 * `readGenerationProfile` reads env per call (no module cache), so each case
 * sets process.env directly and cleans up. Nothing is cached across tests.
 */

describe('generation profile (overall cost/quality knob)', () => {
  afterEach(() => {
    delete process.env.OPENMAIC_GENERATION_PROFILE;
    delete process.env.OPENMAIC_DEPTH_FLOOR_SCALE;
    delete process.env.OPENMAIC_CONTENT_ATTEMPTS;
    delete process.env.OPENMAIC_THINKING_PRESET;
  });

  it('default profile is balanced with lean thinking as the default', () => {
    expect(readGenerationProfile()).toEqual({
      profile: 'balanced',
      depthFloorScale: 1,
      contentAttempts: 2,
      thinkingPreset: 'lean',
    });
  });

  it('economy scales floors down, trims retries, implies lean thinking', () => {
    process.env.OPENMAIC_GENERATION_PROFILE = 'economy';
    const p = readGenerationProfile();
    expect(p.profile).toBe('economy');
    expect(p.depthFloorScale).toBe(0.75);
    expect(p.contentAttempts).toBe(1);
    expect(p.thinkingPreset).toBe('lean');
    // floor scaling rounds toward integers, never below 1: intro's 2 citations
    // at 0.75x -> 2 (round), university's minSubstantive 6 -> 5 (4.5 rounds).
    expect(scaleDepthFloor(2, p.depthFloorScale)).toBe(2);
    expect(scaleDepthFloor(6, p.depthFloorScale)).toBe(5);
    expect(scaleDepthFloor(0, p.depthFloorScale)).toBe(1);
  });

  it('granular overrides beat the profile', () => {
    process.env.OPENMAIC_GENERATION_PROFILE = 'economy';
    process.env.OPENMAIC_DEPTH_FLOOR_SCALE = '1';
    process.env.OPENMAIC_CONTENT_ATTEMPTS = '3';
    process.env.OPENMAIC_THINKING_PRESET = 'quality';
    const p = readGenerationProfile();
    expect(p.depthFloorScale).toBe(1);
    expect(p.contentAttempts).toBe(3);
    expect(p.thinkingPreset).toBe('quality');
  });

  it('unknown profile values resolve to balanced (no silent behavior change)', () => {
    process.env.OPENMAIC_GENERATION_PROFILE = 'turbo-max';
    expect(readGenerationProfile().profile).toBe('balanced');
  });

  it('depth-floor scale clamps out-of-band values into 0.5..1.5', () => {
    process.env.OPENMAIC_DEPTH_FLOOR_SCALE = '99';
    expect(readGenerationProfile().depthFloorScale).toBe(1.5);
    process.env.OPENMAIC_DEPTH_FLOOR_SCALE = '0.1';
    expect(readGenerationProfile().depthFloorScale).toBe(0.5);
  });
});
