// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The mount check and the post-lease spend, as the classroom calls them. */
async function mount() {
  const mod = await import('@/lib/generation/run-intent');
  return (stageId: string, now: number) => {
    const allowed = mod.shouldAutoResume(stageId, now);
    if (allowed) mod.recordAutoResumeAttempt(stageId, now);
    return allowed;
  };
}

describe('generation run intent', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('an explicit hand-off survives a reload and resumes an interrupted course', async () => {
    const { markAutoResume } = await import('@/lib/classroom/auto-resume-marker');
    const resume = await mount();
    markAutoResume('stage-1', 1_000);
    expect(resume('stage-1', 2_000)).toBe(true);
  });

  it('reads as allowed but does not spend until the winner records the attempt', async () => {
    const { markGenerationActive, shouldAutoResume, readGenerationIntent } = await import(
      '@/lib/generation/run-intent'
    );
    markGenerationActive('stage-1', 1_000);
    expect(shouldAutoResume('stage-1', 2_000)).toBe(true);
    // A losing tab checks too, but neither has claimed the lease yet.
    expect(shouldAutoResume('stage-1', 2_100)).toBe(true);
    expect(readGenerationIntent('stage-1', 2_100)?.autoResumes).toBe(0);
  });

  it('a second mount for the same navigation is a no-op', async () => {
    const { markGenerationActive, shouldAutoResume, readGenerationIntent } = await import(
      '@/lib/generation/run-intent'
    );
    markGenerationActive('stage-1', 1_000);
    expect(shouldAutoResume('stage-1', 2_000)).toBe(true);
    expect(shouldAutoResume('stage-1', 2_100)).toBe(true);
    expect(readGenerationIntent('stage-1', 2_100)?.autoResumes).toBe(0);
  });

  it('bounds automatic resumes instead of looping forever', async () => {
    const { markGenerationActive } = await import('@/lib/generation/run-intent');
    const resume = await mount();
    markGenerationActive('stage-1', 1_000);
    for (let i = 1; i <= 3; i += 1) {
      expect(resume('stage-1', 1_000 + i * 60_000)).toBe(true);
    }
    expect(resume('stage-1', 1_000 + 4 * 60_000)).toBe(false);
  });

  it('an explicit stop is authoritative and is never auto-resumed', async () => {
    const { markGenerationActive, markGenerationStopped } = await import(
      '@/lib/generation/run-intent'
    );
    const resume = await mount();
    markGenerationActive('stage-1', 1_000);
    markGenerationStopped('stage-1', 2_000);
    expect(resume('stage-1', 3_000)).toBe(false);
  });

  it('an explicit resume resets the automatic budget', async () => {
    const { markGenerationActive } = await import('@/lib/generation/run-intent');
    const resume = await mount();
    markGenerationActive('stage-1', 1_000);
    for (let i = 1; i <= 3; i += 1) {
      expect(resume('stage-1', 1_000 + i * 60_000)).toBe(true);
    }
    expect(resume('stage-1', 1_000 + 4 * 60_000)).toBe(false);
    markGenerationActive('stage-1', 1_000 + 5 * 60_000);
    expect(resume('stage-1', 1_000 + 6 * 60_000)).toBe(true);
  });

  it('a quiet period resets the attempt counter', async () => {
    const { markGenerationActive } = await import('@/lib/generation/run-intent');
    const resume = await mount();
    markGenerationActive('stage-1', 1_000);
    for (let i = 1; i <= 3; i += 1) {
      expect(resume('stage-1', 1_000 + i * 60_000)).toBe(true);
    }
    // The window restarts at the last attempt (1_000 + 3 min), so 35 min from
    // the first attempt clears the full 30-min quiet window.
    expect(resume('stage-1', 1_000 + 35 * 60_000)).toBe(true);
  });

  it('a heartbeat keeps a long run alive without spending auto-resume budget', async () => {
    const {
      markGenerationActive,
      touchGenerationIntent,
      shouldAutoResume,
      readGenerationIntent,
    } = await import('@/lib/generation/run-intent');
    const HOUR = 60 * 60_000;
    markGenerationActive('stage-1', 1_000);
    // A scene commits every few minutes over two days; each one refreshes at.
    for (let h = 1; h <= 48; h += 1) touchGenerationIntent('stage-1', h * HOUR);
    expect(readGenerationIntent('stage-1', 49 * HOUR)?.autoResumes).toBe(0);
    expect(shouldAutoResume('stage-1', 49 * HOUR)).toBe(true);
  });

  it('a stale intent is ignored', async () => {
    const { markGenerationActive } = await import('@/lib/generation/run-intent');
    const resume = await mount();
    markGenerationActive('stage-1', 1_000);
    expect(resume('stage-1', 1_000 + 25 * 60 * 60_000)).toBe(false);
  });

  it('intents are isolated per course and cleared once settled', async () => {
    const { markGenerationActive, clearGenerationIntent } = await import(
      '@/lib/generation/run-intent'
    );
    const resume = await mount();
    markGenerationActive('stage-1', 1_000);
    expect(resume('stage-2', 2_000)).toBe(false);
    clearGenerationIntent('stage-1');
    expect(resume('stage-1', 3_000)).toBe(false);
  });

  it('fails safe when storage is unreadable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { markGenerationActive } = await import('@/lib/generation/run-intent');
    const resume = await mount();
    markGenerationActive('stage-1', 1_000);
    expect(resume('stage-1', 2_000)).toBe(false);
  });
});
