// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('auto-resume marker', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.resetModules();
  });

  it('a course that is only opened does not resume by itself', async () => {
    const { consumeAutoResume } = await import('@/lib/classroom/auto-resume-marker');
    expect(consumeAutoResume('stage-1')).toBe(false);
  });

  it('the hand-off from generation-preview resumes, and the marker is spent', async () => {
    const { markAutoResume, consumeAutoResume } =
      await import('@/lib/classroom/auto-resume-marker');
    markAutoResume('stage-1', 1_000);
    expect(consumeAutoResume('stage-1', 2_000)).toBe(true);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('a second mount for the same navigation still sees the hand-off', async () => {
    const { markAutoResume, consumeAutoResume } =
      await import('@/lib/classroom/auto-resume-marker');
    markAutoResume('stage-1', 1_000);
    expect(consumeAutoResume('stage-1', 2_000)).toBe(true);
    expect(consumeAutoResume('stage-1', 5_000)).toBe(true);
  });

  it('reopening later, or a different course, does not', async () => {
    const { markAutoResume, consumeAutoResume } =
      await import('@/lib/classroom/auto-resume-marker');
    markAutoResume('stage-1', 1_000);
    expect(consumeAutoResume('stage-1', 2_000)).toBe(true);
    expect(consumeAutoResume('stage-1', 2_000 + 31_000)).toBe(false);
    expect(consumeAutoResume('stage-2', 2_000)).toBe(false);
  });

  it('ignores a stale marker', async () => {
    const { markAutoResume, consumeAutoResume } =
      await import('@/lib/classroom/auto-resume-marker');
    markAutoResume('stage-1', 1_000);
    expect(consumeAutoResume('stage-1', 1_000 + 6 * 60_000)).toBe(false);
  });

  it('fails safe when storage is unreadable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { consumeAutoResume } = await import('@/lib/classroom/auto-resume-marker');
    expect(consumeAutoResume('stage-1')).toBe(false);
    vi.restoreAllMocks();
  });
});
